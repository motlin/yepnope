import {describe, expect, it, vi} from "vitest";
import {listNamespaceObjects, runStorageAdministration, type StorageAdminEnvironment} from "../scripts/admin-storage";

const ALICE_OBJECT_ID = "a".repeat(64);
const BOB_OBJECT_ID = "b".repeat(64);
const CHARLIE_OBJECT_ID = "c".repeat(64);

const TEST_ENVIRONMENT = {
	CLOUDFLARE_ACCOUNT_ID: "example-account-id",
	CLOUDFLARE_API_TOKEN: "example-cloudflare-api-token",
	YEPNOPE_DO_NAMESPACE_ID: "example-namespace-id",
	YEPNOPE_ADMIN_URL: "https://admin.example.com",
	CF_ACCESS_CLIENT_ID: "example-client-id.access",
	CF_ACCESS_CLIENT_SECRET: "example-client-secret",
} satisfies StorageAdminEnvironment;

function json(body: unknown, status = 200): Response {
	return Response.json(body, {status});
}

function requestUrl(input: RequestInfo | URL): URL {
	return new URL(input instanceof Request ? input.url : input.toString());
}

function namespacePage(objects: Array<{id: string; hasStoredData: boolean}>, cursor: string | null = null) {
	return json({success: true, result: objects, result_info: {cursor}});
}

function inventoryContext(liveOwnerObjectIds: string[] = []) {
	return json({
		d1: {table_counts: [{name: "user", rows: liveOwnerObjectIds.length}]},
		live_owner_object_ids: liveOwnerObjectIds,
	});
}

describe("known Durable Object IDs", () => {
	it("follows every cursor and returns sorted IDs with their stored-data state", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(namespacePage([{id: BOB_OBJECT_ID, hasStoredData: true}], "next-page"))
			.mockResolvedValueOnce(namespacePage([{id: ALICE_OBJECT_ID, hasStoredData: false}]));

		expect(await listNamespaceObjects(TEST_ENVIRONMENT, request)).toStrictEqual([
			{id: ALICE_OBJECT_ID, hasStoredData: false},
			{id: BOB_OBJECT_ID, hasStoredData: true},
		]);
		expect(
			request.mock.calls.map(([input, init]) => ({
				authorization: new Headers(init?.headers).get("Authorization"),
				url: requestUrl(input).toString(),
			})),
		).toStrictEqual([
			{
				authorization: `Bearer ${TEST_ENVIRONMENT.CLOUDFLARE_API_TOKEN}`,
				url:
					"https://api.cloudflare.com/client/v4/accounts/example-account-id/workers/durable_objects/" +
					"namespaces/example-namespace-id/objects?limit=1000",
			},
			{
				authorization: `Bearer ${TEST_ENVIRONMENT.CLOUDFLARE_API_TOKEN}`,
				url:
					"https://api.cloudflare.com/client/v4/accounts/example-account-id/workers/durable_objects/" +
					"namespaces/example-namespace-id/objects?limit=1000&cursor=next-page",
			},
		]);
	});
});

describe("orphan Durable Object cleanup", () => {
	it("reports only redacted D1 and per-object counts through Access service-token headers", async () => {
		const request = vi.fn<typeof fetch>(async (input, init) => {
			const url = requestUrl(input);
			if (url.hostname === "api.cloudflare.com") {
				return Promise.resolve(
					namespacePage([
						{id: ALICE_OBJECT_ID, hasStoredData: false},
						{id: BOB_OBJECT_ID, hasStoredData: true},
					]),
				);
			}
			const headers = new Headers(init?.headers);
			expect({
				clientId: headers.get("CF-Access-Client-Id"),
				clientSecret: headers.get("CF-Access-Client-Secret"),
			}).toStrictEqual({
				clientId: TEST_ENVIRONMENT.CF_ACCESS_CLIENT_ID,
				clientSecret: TEST_ENVIRONMENT.CF_ACCESS_CLIENT_SECRET,
			});
			return Promise.resolve(
				url.pathname === "/v1/inventory-context"
					? inventoryContext()
					: json({
							objects: [
								{
									object_id: BOB_OBJECT_ID,
									alarm_set: false,
									table_counts: [{name: "devices", rows: 1}],
								},
							],
						}),
			);
		});

		const result = await runStorageAdministration([], TEST_ENVIRONMENT, {fetch: request, write: () => undefined});
		expect(result).toStrictEqual({
			mode: "diagnostics",
			d1: {table_counts: [{name: "user", rows: 0}]},
			stored_object_count: 1,
			stored_objects: [
				{
					object_id: BOB_OBJECT_ID,
					alarm_set: false,
					table_counts: [{name: "devices", rows: 1}],
				},
			],
			orphan_stored_object_ids: [BOB_OBJECT_ID],
			known_empty_object_ids: [ALICE_OBJECT_ID],
			known_object_ids: [ALICE_OBJECT_ID, BOB_OBJECT_ID],
		});
		expect(JSON.stringify(result).includes("example-client-secret")).toBe(false);
	});

	it("defaults to a redacted dry run and requires an exact expected count", async () => {
		const request = vi.fn<typeof fetch>(async (input) => {
			const url = requestUrl(input);
			return Promise.resolve(
				url.hostname === "api.cloudflare.com"
					? namespacePage([
							{id: ALICE_OBJECT_ID, hasStoredData: true},
							{id: BOB_OBJECT_ID, hasStoredData: true},
						])
					: inventoryContext([BOB_OBJECT_ID]),
			);
		});
		const writes: unknown[] = [];

		expect(
			await runStorageAdministration(["cleanup"], TEST_ENVIRONMENT, {
				fetch: request,
				write: (value) => writes.push(value),
			}),
		).toStrictEqual({
			mode: "dry-run",
			stored_object_count: 2,
			orphan_stored_object_count: 1,
			orphan_stored_object_ids: [ALICE_OBJECT_ID],
			known_empty_object_ids: [],
		});
		await expect(
			runStorageAdministration(["cleanup", "--confirm", "--expected-count", "2"], TEST_ENVIRONMENT, {
				fetch: request,
				write: (value) => writes.push(value),
			}),
		).rejects.toThrow("expected 2 orphan object IDs with stored data, found 1");
		expect({
			writes,
			deletionRequests: request.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/delete"))
				.length,
		}).toStrictEqual({
			writes: [],
			deletionRequests: 0,
		});
	});

	it("refuses deletion when the physical inventory changes after confirmation", async () => {
		let inventoryCalls = 0;
		const request = vi.fn<typeof fetch>(async (input) => {
			const url = requestUrl(input);
			if (url.hostname !== "api.cloudflare.com") {
				return Promise.resolve(inventoryContext());
			}
			inventoryCalls += 1;
			return Promise.resolve(
				inventoryCalls === 1
					? namespacePage([{id: ALICE_OBJECT_ID, hasStoredData: true}])
					: namespacePage([
							{id: ALICE_OBJECT_ID, hasStoredData: true},
							{id: CHARLIE_OBJECT_ID, hasStoredData: true},
						]),
			);
		});

		await expect(
			runStorageAdministration(["cleanup", "--confirm", "--expected-count", "1"], TEST_ENVIRONMENT, {
				fetch: request,
				write: () => undefined,
			}),
		).rejects.toThrow("known object IDs, stored-data state, or live owners changed after confirmation");
		expect(request.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/delete"))).toStrictEqual(
			[],
		);
	});

	it("records verified progress and makes a partial failure safe to retry", async () => {
		const storedObjects = new Set([ALICE_OBJECT_ID, BOB_OBJECT_ID]);
		let failBob = true;
		const request = vi.fn<typeof fetch>(async (input, init) => {
			const url = requestUrl(input);
			if (url.hostname === "api.cloudflare.com") {
				return Promise.resolve(
					namespacePage(
						[ALICE_OBJECT_ID, BOB_OBJECT_ID].map((id) => ({id, hasStoredData: storedObjects.has(id)})),
					),
				);
			}
			if (url.pathname === "/v1/inventory-context") {
				return Promise.resolve(inventoryContext());
			}
			const body = JSON.parse(String(init?.body)) as {object_id: string};
			if (body.object_id === BOB_OBJECT_ID && failBob) {
				failBob = false;
				return Promise.resolve(json({error: "temporary_failure"}, 503));
			}
			storedObjects.delete(body.object_id);
			return Promise.resolve(json({object_id: body.object_id, status: "deleted"}));
		});
		const writes: unknown[] = [];

		await expect(
			runStorageAdministration(["cleanup", "--confirm", "--expected-count", "2"], TEST_ENVIRONMENT, {
				fetch: request,
				write: (value) => writes.push(value),
			}),
		).rejects.toThrow("request failed with HTTP 503");
		expect(writes).toStrictEqual([{object_id: ALICE_OBJECT_ID, status: "verified_deallocated"}]);
		expect(
			await runStorageAdministration(["cleanup"], TEST_ENVIRONMENT, {
				fetch: request,
				write: (value) => writes.push(value),
			}),
		).toStrictEqual({
			mode: "dry-run",
			stored_object_count: 1,
			orphan_stored_object_count: 1,
			orphan_stored_object_ids: [BOB_OBJECT_ID],
			known_empty_object_ids: [ALICE_OBJECT_ID],
		});
	});

	it("completes at zero stored objects while known empty IDs remain", async () => {
		const request = vi.fn<typeof fetch>(async (input) => {
			const url = requestUrl(input);
			return Promise.resolve(
				url.hostname === "api.cloudflare.com"
					? namespacePage([
							{id: ALICE_OBJECT_ID, hasStoredData: false},
							{id: BOB_OBJECT_ID, hasStoredData: false},
						])
					: inventoryContext(),
			);
		});

		expect(
			await runStorageAdministration(["cleanup", "--confirm", "--expected-count", "0"], TEST_ENVIRONMENT, {
				fetch: request,
				write: () => undefined,
			}),
		).toStrictEqual({
			deleted_stored_object_count: 0,
			known_empty_object_ids: [ALICE_OBJECT_ID, BOB_OBJECT_ID],
			mode: "confirmed",
			remaining_stored_object_count: 0,
			status: "complete",
		});
		expect(request.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/delete"))).toStrictEqual(
			[],
		);
	});
});
