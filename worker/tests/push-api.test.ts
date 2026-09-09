import {runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it, vi} from "vitest";
import type {UserDurableObject} from "../user-do";
import {hashToken} from "../auth";
import {HEARTBEAT_GRACE_MILLISECONDS, RETENTION_MILLISECONDS} from "../validation";
import {vapidPublicKeyFromJwk} from "../webpush";
import {API_ORIGIN, createBatchOverHttp, authorizeAgentClient, required, worker} from "./helpers";
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
		instance.pushTransport = async (endpoint, request) => {
			sent.push({endpoint, headers: request.headers, body: request.body});
			return Promise.resolve(new Response(null, {status: respondWith}));
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
		const token = await authorizeAgentClient("push-malformed");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/push/subscribe`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({endpoint: "https://push.example.com/x"}),
		});
		expect(response.status).toBe(400);
	});

	it("replaces only the named device for the authenticated user", async () => {
		const userId = "push-replace-alice";
		const token = await authorizeAgentClient(userId);
		const oldReceiver = await createPushReceiver("https://push.example.com/send/old");
		const newReceiver = await createPushReceiver("https://push.example.com/send/new");
		const otherReceiver = await createPushReceiver("https://push.example.com/send/other");
		await subscribe(token, oldReceiver);
		await subscribe(token, otherReceiver);
		const bobToken = await authorizeAgentClient("push-replace-bob");
		await subscribe(bobToken, oldReceiver);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/push/subscribe`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({...newReceiver.subscription, replaces: oldReceiver.subscription.endpoint}),
		});
		expect(response.status).toBe(200);
		await runInDurableObject(env.USER_DO.getByName(userId), (_instance, state) => {
			expect(
				state.storage.sql.exec("SELECT push_subscription FROM devices ORDER BY push_subscription").toArray(),
			).toStrictEqual(
				[newReceiver, otherReceiver].map((receiver) => ({
					push_subscription: JSON.stringify(receiver.subscription),
				})),
			);
		});
		await runInDurableObject(env.USER_DO.getByName("push-replace-bob"), (_instance, state) => {
			expect(state.storage.sql.exec("SELECT push_subscription FROM devices").toArray()).toStrictEqual([
				{push_subscription: JSON.stringify(oldReceiver.subscription)},
			]);
		});
	});

	it("keeps a device's identity when it names itself as predecessor", async () => {
		const userId = "push-replace-self";
		const token = await authorizeAgentClient(userId);
		const receiver = await createPushReceiver("https://push.example.com/send/self");
		await subscribe(token, receiver);
		await runInDurableObject(env.USER_DO.getByName(userId), (_instance, state) => {
			state.storage.sql.exec("UPDATE devices SET label = ?, created_at = ?", "Alice phone", 1000);
		});
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/push/subscribe`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({...receiver.subscription, replaces: receiver.subscription.endpoint}),
		});
		expect(response.status).toBe(200);
		await runInDurableObject(env.USER_DO.getByName(userId), (_instance, state) => {
			expect(
				state.storage.sql.exec("SELECT label, created_at, push_subscription FROM devices").toArray(),
			).toStrictEqual([
				{label: "Alice phone", created_at: 1000, push_subscription: JSON.stringify(receiver.subscription)},
			]);
		});
	});

	it("stores the device, deduplicated by endpoint", async () => {
		const userId = "push-subscribe";
		const token = await authorizeAgentClient(userId);
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
	it.each([
		{status: 400, body: '  {"reason": "BadWebPushTopic"}\n', excerpt: '{"reason": "BadWebPushTopic"}'},
		{status: 403, body: "Invalid\n\t JWT", excerpt: "Invalid JWT"},
		{status: 404, body: "Not found", excerpt: "Not found"},
		{status: 410, body: "Gone", excerpt: "Gone"},
		{status: 429, body: "", excerpt: ""},
		{status: 503, body: "x".repeat(9000), excerpt: `${"x".repeat(200)}…`},
		{status: 500, body: "x".repeat(200), excerpt: "x".repeat(200)},
		{status: 201, body: "", excerpt: ""},
	])("logs bounded push failure details for status $status", async ({status, body, excerpt}) => {
		const userId = `push-rejected-alice-${status}`;
		const token = await authorizeAgentClient(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}]);
		const receiver = await createPushReceiver("https://push.example.com/send/private-token");
		await subscribe(token, receiver);
		await runInDurableObject(env.USER_DO.getByName(userId), async (instance: UserDurableObject, state) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			try {
				instance.pushTransport = async () => Promise.resolve(new Response(body, {status}));
				const delivered = await instance.sendBatchPush(created.batch_id);
				expect({
					delivered,
					warnings: warning.mock.calls,
					devices: state.storage.sql.exec("SELECT push_subscription FROM devices").toArray(),
				}).toStrictEqual({
					delivered: status === 201 ? 1 : 0,
					warnings:
						status === 201
							? []
							: [
									[
										`[push] delivery failed origin=https://push.example.com status=${status} body=${excerpt}`,
									],
								],
					devices:
						status === 404 || status === 410
							? []
							: [{push_subscription: JSON.stringify(receiver.subscription)}],
				});
			} finally {
				warning.mockRestore();
			}
		});
	});

	it.each(["transport", "response body"])("continues delivery after a failed %s", async (failure) => {
		const userId = `push-unreachable-alice-${failure}`;
		const token = await authorizeAgentClient(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}]);
		const rejected = await createPushReceiver("https://push.example.com/send/rejected");
		const accepted = await createPushReceiver("https://other-push.example.com/send/accepted");
		await subscribe(token, rejected);
		await subscribe(token, accepted);
		await runInDurableObject(env.USER_DO.getByName(userId), async (instance: UserDurableObject, state) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			try {
				instance.pushTransport = async (endpoint) => {
					if (endpoint === accepted.subscription.endpoint) {
						return Promise.resolve(new Response(null, {status: 201}));
					}
					if (failure === "transport") {
						return Promise.reject(new Error("Service unavailable"));
					}
					const response = new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.error(new Error("Body unavailable"));
							},
						}),
						{status: 410},
					);
					return Promise.resolve(response);
				};
				const delivered = await instance.sendBatchPush(created.batch_id);
				expect({
					delivered,
					warnings: warning.mock.calls,
					devices: state.storage.sql
						.exec("SELECT push_subscription FROM devices ORDER BY push_subscription")
						.toArray(),
				}).toStrictEqual({
					delivered: 1,
					warnings: [
						[
							failure === "transport"
								? "[push] delivery failed origin=https://push.example.com status=0 error=Service unavailable"
								: "[push] delivery failed origin=https://push.example.com status=410 error=Body unavailable",
						],
					],
					devices: (failure === "transport" ? [accepted, rejected] : [accepted]).map((receiver) => ({
						push_subscription: JSON.stringify(receiver.subscription),
					})),
				});
			} finally {
				warning.mockRestore();
			}
		});
	});

	it("clears a batch only after every question is answered and preserves other outstanding questions", async () => {
		const userId = "push-clear-alice";
		const token = await authorizeAgentClient(userId);
		const created = await createBatchOverHttp(token, "demo", [
			{title: "Ship it?", body: ""},
			{title: "Tag it?", body: ""},
		]);
		await createBatchOverHttp(token, "other-demo", [{title: "Keep waiting?", body: ""}]);
		const receiver = await createPushReceiver("https://push.example.com/send/clear-alice");
		await subscribe(token, receiver);
		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, async (instance: UserDurableObject) => {
			const sent: SentPush[] = [];
			instance.pushTransport = async (endpoint, request) => {
				sent.push({endpoint, ...request});
				return Promise.resolve(new Response(null, {status: 201}));
			};
			await instance.submitAnswers([
				{question_id: required(created.question_ids[0], "first question"), disposition: "yep"},
			]);
			expect(sent).toStrictEqual([]);
			await instance.submitAnswers([
				{question_id: required(created.question_ids[1], "second question"), disposition: "nope"},
			]);
			expect(
				await Promise.all(
					sent.map(async (push) => ({
						endpoint: push.endpoint,
						topic: push.headers["Topic"],
						payload: JSON.parse(await receiver.decrypt(push.body)),
					})),
				),
			).toStrictEqual([
				{
					endpoint: receiver.subscription.endpoint,
					topic: `clear-${(await hashToken(created.batch_id)).slice(0, 26)}`,
					payload: {type: "clear", batch_id: created.batch_id, outstanding: 1},
				},
			]);
		});
	});

	it.each(["heartbeat", "retention"])("clears each batch after %s expiry", async (expiry) => {
		const userId = `push-clear-${expiry}`;
		const token = await authorizeAgentClient(userId);
		const first = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}]);
		const second = await createBatchOverHttp(token, "other-demo", [{title: "Tag it?", body: ""}]);
		const receiver = await createPushReceiver("https://push.example.com/send/clear-expired");
		await subscribe(token, receiver);
		await runInDurableObject(env.USER_DO.getByName(userId), async (instance: UserDurableObject, state) => {
			const sent: SentPush[] = [];
			instance.pushTransport = async (endpoint, request) => {
				sent.push({endpoint, ...request});
				return Promise.resolve(new Response(null, {status: 201}));
			};
			if (expiry === "heartbeat") {
				state.storage.sql.exec(
					"UPDATE batches SET last_heartbeat_at = last_heartbeat_at - ?",
					HEARTBEAT_GRACE_MILLISECONDS,
				);
			} else {
				state.storage.sql.exec("UPDATE batches SET created_at = created_at - ?", RETENTION_MILLISECONDS);
			}
			await instance.alarm();
			const actual = await Promise.all(
				sent.map(async (push) => ({
					topic: push.headers["Topic"],
					payload: JSON.parse(await receiver.decrypt(push.body)),
				})),
			);
			const expected = await Promise.all(
				[first, second].map(async (batch) => ({
					topic: `clear-${(await hashToken(batch.batch_id)).slice(0, 26)}`,
					payload: {type: "clear", batch_id: batch.batch_id, outstanding: 0},
				})),
			);
			expect(actual.sort((left, right) => String(left.topic).localeCompare(String(right.topic)))).toStrictEqual(
				expected.sort((left, right) => left.topic.localeCompare(right.topic)),
			);
		});
	});

	it("sends one push per batch with count, not question text", async () => {
		const userId = "push-batch";
		const token = await authorizeAgentClient(userId);
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
		const token = await authorizeAgentClient(userId);
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

	it.each([404, 410])("drops devices when the push service returns %i", async (staleStatus) => {
		const userId = `push-gone-${staleStatus}`;
		const token = await authorizeAgentClient(userId);
		const receiver = await createPushReceiver("https://push.example.com/send/gone");
		await subscribe(token, receiver);
		const created = await createBatchOverHttp(token, "demo", [{title: "Still there?", body: ""}]);

		const {delivered} = await deliverBatchPush(userId, created.batch_id, staleStatus);
		expect(delivered).toBe(0);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM devices").one()["total"]).toBe(0);
		});
	});
});
