import {runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import type {UserDurableObject} from "../user-do";
import {vapidPublicKeyFromJwk} from "../webpush";
import {API_ORIGIN, createBatchOverHttp, registerMachineToken, required, worker} from "./helpers";
import {createPushReceiver, type PushReceiver} from "./push-helpers";

async function subscribe(token: string, receiver: PushReceiver): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/push/subscribe`, {
		method: "POST",
		headers: {Authorization: `Bearer ${token}`},
		body: JSON.stringify(receiver.subscription),
	});
}

interface SentPush {
	endpoint: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

async function deliverBatchPush(
	userId: string,
	batchId: string,
	respondWith: number,
): Promise<{sent: SentPush[]; delivered: number}> {
	const stub = env.USER_DO.getByName(userId);
	return runInDurableObject(stub, async (instance: UserDurableObject) => {
		const sent: SentPush[] = [];
		instance.pushTransport = (endpoint, request) => {
			sent.push({endpoint, headers: request.headers, body: request.body});
			return respondWith;
		};
		const delivered = await instance.sendBatchPush(batchId);
		return {sent, delivered};
	});
}

describe("GET /api/v1/push/public-key", () => {
	it("returns the VAPID application server key without auth", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/push/public-key`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			public_key: vapidPublicKeyFromJwk(JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey),
		});
	});
});

describe("POST /api/v1/push/subscribe", () => {
	it("requires authentication", async () => {
		const receiver = await createPushReceiver("https://push.example.com/send/noauth");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/push/subscribe`, {
			method: "POST",
			body: JSON.stringify(receiver.subscription),
		});
		expect(response.status).toBe(401);
	});

	it("rejects a malformed subscription", async () => {
		const token = await registerMachineToken("push-malformed");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/push/subscribe`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({endpoint: "https://push.example.com/x"}),
		});
		expect(response.status).toBe(400);
	});

	it("stores the device, deduplicated by endpoint", async () => {
		const userId = "push-subscribe";
		const token = await registerMachineToken(userId);
		const receiver = await createPushReceiver("https://push.example.com/send/dedupe");
		expect((await subscribe(token, receiver)).status).toBe(200);
		expect((await subscribe(token, receiver)).status).toBe(200);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			const rows = state.storage.sql.exec("SELECT push_subscription FROM devices").toArray();
			expect(rows).toHaveLength(1);
			expect(JSON.parse(rows[0]?.["push_subscription"] as string)).toEqual(receiver.subscription);
		});
	});
});

describe("sendBatchPush", () => {
	it("sends one push per batch with count, not question text", async () => {
		const userId = "push-batch";
		const token = await registerMachineToken(userId);
		const receiver = await createPushReceiver("https://push.example.com/send/batch");
		await subscribe(token, receiver);
		const created = await createBatchOverHttp(token, "monorepo-migration", [
			{title: "Secret one?", body: "secret"},
			{title: "Secret two?", body: "secret"},
		]);

		const {sent, delivered} = await deliverBatchPush(userId, created.batch_id, 201);
		expect(delivered).toBe(1);
		const push = required(sent[0], "sent push");
		expect(push.endpoint).toBe(receiver.subscription.endpoint);
		const payload = JSON.parse(await receiver.decrypt(push.body));
		expect(payload).toStrictEqual({
			batch_id: created.batch_id,
			project: "monorepo-migration",
			count: 2,
			outstanding: 2,
		});
	});

	it("keeps a single-question payload private", async () => {
		const userId = "push-single";
		const token = await registerMachineToken(userId);
		const receiver = await createPushReceiver("https://push.example.com/send/single");
		await subscribe(token, receiver);
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: "the whole thing"}]);

		const {sent} = await deliverBatchPush(userId, created.batch_id, 201);
		const payload = JSON.parse(await receiver.decrypt(required(sent[0], "sent push").body));
		expect(payload).toStrictEqual({
			batch_id: created.batch_id,
			project: "demo",
			count: 1,
			outstanding: 1,
		});
	});

	it("drops devices the push service reports gone", async () => {
		const userId = "push-gone";
		const token = await registerMachineToken(userId);
		const receiver = await createPushReceiver("https://push.example.com/send/gone");
		await subscribe(token, receiver);
		const created = await createBatchOverHttp(token, "demo", [{title: "Still there?", body: ""}]);

		const {delivered} = await deliverBatchPush(userId, created.batch_id, 410);
		expect(delivered).toBe(0);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM devices").one()["total"]).toBe(0);
		});
	});
});
