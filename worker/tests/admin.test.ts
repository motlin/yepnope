import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from "jose";
import {describe, expect, it} from "vitest";
import {authenticateAccessRequest, createAdminHandler, type AdminEnvironment} from "../admin";
import type {UserDurableObject} from "../user-do";
import {createVerifiedBrowserSession} from "./helpers";
import {createPushReceiver} from "./push-helpers";

const ADMIN_ORIGIN = "https://admin.yepnope.app";
const TEST_ACCESS_ENVIRONMENT = {
	ACCESS_AUD: "access-audience-for-tests",
	ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
	DB: env.DB,
	USER_DO: env.USER_DO,
} satisfies AdminEnvironment;

const authenticatedAdmin = createAdminHandler(async (request) => {
	if (request.headers.get("Cf-Access-Jwt-Assertion") !== "verified-by-access") {
		return Promise.reject(new Error("invalid Access assertion"));
	}
	return Promise.resolve();
});

function authenticatedRequest(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("Cf-Access-Jwt-Assertion", "verified-by-access");
	return new Request(`${ADMIN_ORIGIN}${path}`, {...init, headers});
}

describe("admin Access authentication", () => {
	it("rejects missing and invalid Access assertions before routing", async () => {
		const missing = await authenticatedAdmin.fetch(new Request(`${ADMIN_ORIGIN}/missing`), TEST_ACCESS_ENVIRONMENT);
		const invalid = await authenticatedAdmin.fetch(
			new Request(`${ADMIN_ORIGIN}/missing`, {headers: {"Cf-Access-Jwt-Assertion": "forged"}}),
			TEST_ACCESS_ENVIRONMENT,
		);
		const valid = await authenticatedAdmin.fetch(authenticatedRequest("/missing"), TEST_ACCESS_ENVIRONMENT);

		expect(
			await Promise.all(
				[missing, invalid, valid].map(async (response) => ({
					body: await response.json(),
					cacheControl: response.headers.get("Cache-Control"),
					status: response.status,
				})),
			),
		).toStrictEqual([
			{body: {error: "unauthorized"}, cacheControl: "private, no-store", status: 401},
			{body: {error: "unauthorized"}, cacheControl: "private, no-store", status: 401},
			{body: {error: "not_found"}, cacheControl: "private, no-store", status: 404},
		]);
	});

	it("verifies the Access issuer, audience, and signature", async () => {
		const keyPair = await generateKeyPair("RS256");
		const publicKey = await exportJWK(keyPair.publicKey);
		publicKey.kid = "access-test-key";
		const keySet = createLocalJWKSet({keys: [publicKey]});
		const validToken = await new SignJWT({})
			.setProtectedHeader({alg: "RS256", kid: publicKey.kid})
			.setIssuer(TEST_ACCESS_ENVIRONMENT.ACCESS_TEAM_DOMAIN)
			.setAudience(TEST_ACCESS_ENVIRONMENT.ACCESS_AUD)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(keyPair.privateKey);
		const invalidAudienceToken = await new SignJWT({})
			.setProtectedHeader({alg: "RS256", kid: publicKey.kid})
			.setIssuer(TEST_ACCESS_ENVIRONMENT.ACCESS_TEAM_DOMAIN)
			.setAudience("different-access-application")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(keyPair.privateKey);

		await expect(
			authenticateAccessRequest(
				new Request(ADMIN_ORIGIN, {headers: {"Cf-Access-Jwt-Assertion": validToken}}),
				TEST_ACCESS_ENVIRONMENT,
				keySet,
			),
		).resolves.toBeUndefined();
		await expect(
			authenticateAccessRequest(
				new Request(ADMIN_ORIGIN, {headers: {"Cf-Access-Jwt-Assertion": invalidAudienceToken}}),
				TEST_ACCESS_ENVIRONMENT,
				keySet,
			),
		).rejects.toThrow('unexpected "aud" claim value');
	});
});

describe("admin storage diagnostics and cleanup", () => {
	it("returns counts without returning stored credentials, question text, email tokens, or push capabilities", async () => {
		const session = await createVerifiedBrowserSession("alice-admin@example.com");
		const secretDeviceCode = "device-code-secret-that-must-not-leak";
		await env.DB.prepare(
			"INSERT INTO device_code (id, device_code, user_code, user_id, expires_at, status) " +
				"VALUES (?, ?, ?, ?, ?, 'pending')",
		)
			.bind(crypto.randomUUID(), secretDeviceCode, "ABC23456", session.userId, Date.UTC(2000, 0, 2))
			.run();
		const object = env.USER_DO.getByName(session.userId);
		const receiver = await createPushReceiver("https://push.example.com/secret-capability");
		await object.registerDevice(receiver.subscription, "Alice browser");
		await object.createBatch({
			project: "private-project",
			questions: [{title: "Private title", body: "Private body"}],
		});
		const objectId = env.USER_DO.idFromName(session.userId).toString();

		const contextResponse = await authenticatedAdmin.fetch(
			authenticatedRequest("/v1/inventory-context"),
			TEST_ACCESS_ENVIRONMENT,
		);
		const diagnosticsResponse = await authenticatedAdmin.fetch(
			authenticatedRequest("/v1/objects/diagnostics", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({object_ids: [objectId]}),
			}),
			TEST_ACCESS_ENVIRONMENT,
		);
		const diagnostics = await diagnosticsResponse.json();
		const serialized = JSON.stringify({context: await contextResponse.json(), diagnostics});

		expect({
			contextStatus: contextResponse.status,
			diagnostics,
			diagnosticsStatus: diagnosticsResponse.status,
		}).toStrictEqual({
			contextStatus: 200,
			diagnostics: {
				objects: [
					{
						alarm_set: true,
						object_id: objectId,
						table_counts: [
							{name: "__drizzle_migrations", rows: 1},
							{name: "answers", rows: 0},
							{name: "batches", rows: 1},
							{name: "devices", rows: 1},
							{name: "question_activity", rows: 1},
							{name: "questions", rows: 1},
							{name: "state", rows: 1},
						],
					},
				],
			},
			diagnosticsStatus: 200,
		});
		expect([
			serialized.includes(secretDeviceCode),
			serialized.includes("ABC23456"),
			serialized.includes("alice-admin@example.com"),
			serialized.includes("Private title"),
			serialized.includes("Private body"),
			serialized.includes("secret-capability"),
		]).toStrictEqual([false, false, false, false, false, false]);
	});

	it("refuses a live owner and deallocates orphan SQL, KV, and alarms", async () => {
		const live = await createVerifiedBrowserSession("live-owner@example.com");
		const liveObjectId = env.USER_DO.idFromName(live.userId).toString();
		const liveResponse = await authenticatedAdmin.fetch(
			authenticatedRequest("/v1/objects/delete", {
				method: "POST",
				body: JSON.stringify({object_id: liveObjectId}),
			}),
			TEST_ACCESS_ENVIRONMENT,
		);

		const orphan = env.USER_DO.getByName("orphan-alice");
		await orphan.createBatch({project: "example-project", questions: [{title: "Delete?", body: "Yes."}]});
		await runInDurableObject(orphan, async (_instance: UserDurableObject, state) => {
			await state.storage.put("test-key", "test-value");
		});
		const orphanObjectId = env.USER_DO.idFromName("orphan-alice").toString();
		const orphanResponse = await authenticatedAdmin.fetch(
			authenticatedRequest("/v1/objects/delete", {
				method: "POST",
				body: JSON.stringify({object_id: orphanObjectId}),
			}),
			TEST_ACCESS_ENVIRONMENT,
		);

		expect({
			live: {body: await liveResponse.json(), status: liveResponse.status},
			orphan: {body: await orphanResponse.json(), status: orphanResponse.status},
		}).toStrictEqual({
			live: {body: {error: "live_owner"}, status: 409},
			orphan: {body: {object_id: orphanObjectId, status: "deleted"}, status: 200},
		});
		await runInDurableObject(orphan, async (_instance: UserDurableObject, state) => {
			expect({
				alarm: await state.storage.getAlarm(),
				key: await state.storage.get("test-key"),
				tables: state.storage.sql
					.exec<{name: string}>("SELECT name FROM sqlite_schema WHERE type = 'table'")
					.toArray(),
			}).toStrictEqual({alarm: null, key: undefined, tables: []});
		});
	});
});
