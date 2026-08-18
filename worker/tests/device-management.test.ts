import {runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {hashToken} from "../auth";
import type {UserDurableObject} from "../user-do";
import {API_ORIGIN, createVerifiedBrowserSession, worker} from "./helpers";

const CREATED_AT = Date.UTC(2000, 0, 1);
const LAST_USED_AT = Date.UTC(2000, 0, 2);

interface SeededMachine {
	id: string;
	token: string;
}

async function seedMachine(userId: string, id: string, label: string): Promise<SeededMachine> {
	const token = `machine-credential-${id}`;
	await env.DB.prepare(
		"INSERT INTO machine_tokens (id, token_hash, user_id, label, credential_type, created_at, last_used_at) " +
			"VALUES (?, ?, ?, ?, 'machine', ?, ?)",
	)
		.bind(id, await hashToken(token), userId, label, CREATED_AT, LAST_USED_AT)
		.run();
	return {id, token};
}

async function seedPushDevice(userId: string, endpoint: string, label: string): Promise<string> {
	const subscription = {endpoint, keys: {p256dh: "fake-public-key", auth: "fake-auth-secret"}};
	const stub = env.USER_DO.getByName(userId);
	await stub.registerDevice(subscription, label);
	await runInDurableObject(stub, (_instance: UserDurableObject, state) => {
		state.storage.sql.exec("UPDATE devices SET created_at = ?", CREATED_AT);
	});
	return hashToken(endpoint);
}

async function accountRequest(cookie: string, path: string, method = "GET", label?: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: {
			Cookie: cookie,
			...(label === undefined ? {} : {"Content-Type": "application/json"}),
		},
		...(label === undefined ? {} : {body: JSON.stringify({label})}),
	});
}

describe("account device management", () => {
	it("requires a verified browser session instead of a machine credential", async () => {
		const session = await createVerifiedBrowserSession();
		const machine = await seedMachine(session.userId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Alice laptop");

		const unauthenticated = await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`);
		const machineAuthenticated = await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`, {
			headers: {Authorization: `Bearer ${machine.token}`},
		});

		expect([unauthenticated.status, machineAuthenticated.status]).toStrictEqual([401, 401]);
	});

	it("lists safe machine and browser metadata without credential material", async () => {
		const session = await createVerifiedBrowserSession();
		const machine = await seedMachine(session.userId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Alice laptop");
		const endpoint = "https://push.example.com/send/alice-device";
		const pushDeviceId = await seedPushDevice(session.userId, endpoint, "Alice browser");

		const response = await accountRequest(session.cookie, "/api/v1/account/devices");
		const body = await response.json();

		expect({body, status: response.status}).toStrictEqual({
			body: {
				machines: [
					{
						id: machine.id,
						label: "Alice laptop",
						created_at: CREATED_AT,
						last_used_at: LAST_USED_AT,
					},
				],
				push_devices: [{id: pushDeviceId, label: "Alice browser", created_at: CREATED_AT}],
			},
			status: 200,
		});
		const serialized = JSON.stringify(body);
		expect(serialized.includes(await hashToken(machine.token))).toBe(false);
		expect(serialized.includes(endpoint)).toBe(false);
		expect(serialized.includes("fake-auth-secret")).toBe(false);
	});

	it("renames owned devices and rejects cross-account mutations", async () => {
		const alice = await createVerifiedBrowserSession();
		const bob = await createVerifiedBrowserSession();
		const machine = await seedMachine(alice.userId, "cccccccccccccccccccccccccccccccc", "Alice laptop");
		const pushDeviceId = await seedPushDevice(
			alice.userId,
			"https://push.example.com/send/alice-owned",
			"Alice browser",
		);

		const deniedMachine = await accountRequest(
			bob.cookie,
			`/api/v1/account/machines/${machine.id}`,
			"PUT",
			"Bob laptop",
		);
		const deniedPush = await accountRequest(bob.cookie, `/api/v1/account/push-devices/${pushDeviceId}`, "DELETE");
		expect([deniedMachine.status, deniedPush.status]).toStrictEqual([404, 404]);

		const renamedMachine = await accountRequest(
			alice.cookie,
			`/api/v1/account/machines/${machine.id}`,
			"PUT",
			"Work laptop",
		);
		const renamedPush = await accountRequest(
			alice.cookie,
			`/api/v1/account/push-devices/${pushDeviceId}`,
			"PUT",
			"Phone notifications",
		);
		expect([renamedMachine.status, renamedPush.status]).toStrictEqual([200, 200]);

		const listed = await accountRequest(alice.cookie, "/api/v1/account/devices");
		expect(await listed.json()).toStrictEqual({
			machines: [
				{
					id: machine.id,
					label: "Work laptop",
					created_at: CREATED_AT,
					last_used_at: LAST_USED_AT,
				},
			],
			push_devices: [{id: pushDeviceId, label: "Phone notifications", created_at: CREATED_AT}],
		});
	});

	it("invalidates a revoked machine and removes a revoked push device", async () => {
		const session = await createVerifiedBrowserSession();
		const machine = await seedMachine(session.userId, "dddddddddddddddddddddddddddddddd", "Alice laptop");
		const pushDeviceId = await seedPushDevice(
			session.userId,
			"https://push.example.com/send/revoked-device",
			"Alice browser",
		);
		const stub = env.USER_DO.getByName(session.userId);
		expect(await stub.setAfk(true, true)).toStrictEqual({status: "updated", afk: true});

		const revokedMachine = await accountRequest(session.cookie, `/api/v1/account/machines/${machine.id}`, "DELETE");
		expect({body: await revokedMachine.json(), status: revokedMachine.status}).toStrictEqual({
			body: {pairing: {machine_count: 0, paired: false}, status: "ok"},
			status: 200,
		});
		expect(
			(
				await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
					headers: {Authorization: `Bearer ${machine.token}`},
				})
			).status,
		).toBe(401);
		expect(await stub.getAfk(true)).toBe(false);
		const revokedRow = await env.DB.prepare("SELECT revoked_at FROM machine_tokens WHERE id = ?")
			.bind(machine.id)
			.first<{revoked_at: number | null}>();
		if (revokedRow === null) {
			throw new Error("missing revoked machine");
		}
		expect(revokedRow.revoked_at).toBeTypeOf("number");

		const revokedPush = await accountRequest(
			session.cookie,
			`/api/v1/account/push-devices/${pushDeviceId}`,
			"DELETE",
		);
		expect({body: await revokedPush.json(), status: revokedPush.status}).toStrictEqual({
			body: {status: "ok"},
			status: 200,
		});
		expect(await stub.listPushDevices()).toStrictEqual([]);
	});
});
