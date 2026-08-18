import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {revokeMachineToken} from "../pairing";
import {
	API_ORIGIN,
	createBatchOverHttp,
	createVerifiedBrowserSession,
	nextMessage,
	postAnswers,
	registerMachineToken,
	required,
	worker,
} from "./helpers";

async function getAfk(token: string): Promise<{status: number; afk?: boolean}> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
		headers: {Authorization: `Bearer ${token}`},
	});
	if (response.status !== 200) {
		return {status: response.status};
	}
	const body = await response.json<{afk: boolean}>();
	return {status: response.status, afk: body.afk};
}

async function putAfk(token: string, afk: boolean): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
		method: "PUT",
		headers: {Authorization: `Bearer ${token}`},
		body: JSON.stringify({afk}),
	});
}

describe("AFK mode", () => {
	it("defaults signed-in accounts and newly paired machines to off", async () => {
		const session = await createVerifiedBrowserSession();
		const unpaired = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {headers: {Cookie: session.cookie}});
		expect({body: await unpaired.json(), status: unpaired.status}).toStrictEqual({
			body: {afk: false},
			status: 200,
		});
		await runInDurableObject(env.USER_DO.getByName(session.userId), (_instance, state) => {
			expect(state.storage.sql.exec("SELECT afk FROM state").one()).toStrictEqual({afk: 0});
		});
		const streamResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {Cookie: session.cookie, Upgrade: "websocket"},
		});
		const socket = required(streamResponse.webSocket ?? undefined, "question websocket");
		const unpairedState = nextMessage(socket);
		socket.accept();
		expect(JSON.parse(await unpairedState)).toStrictEqual({
			type: "current_deck",
			afk: false,
			paired: false,
			machine_count: 0,
			current_deck: [],
		});
		const issued = await worker.fetch(`${API_ORIGIN}/api/v1/pair/code`, {
			method: "POST",
			headers: {Cookie: session.cookie},
		});
		const {code} = await issued.json<{code: string}>();
		const pairedState = nextMessage(socket);
		const claimed = await worker.fetch(`${API_ORIGIN}/api/v1/pair/claim`, {
			method: "POST",
			body: JSON.stringify({code, label: "Alice's laptop"}),
		});
		const {token} = await claimed.json<{token: string}>();

		expect(JSON.parse(await pairedState)).toStrictEqual({
			type: "current_deck",
			afk: false,
			paired: true,
			machine_count: 1,
			current_deck: [],
		});
		expect(await getAfk(token)).toStrictEqual({status: 200, afk: false});
		socket.close();
	});

	it("requires auth", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`);
		expect(response.status).toBe(401);
	});

	it("returns a typed conflict when an unpaired account tries to turn AFK on", async () => {
		const session = await createVerifiedBrowserSession();
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
			method: "PUT",
			headers: {Cookie: session.cookie},
			body: JSON.stringify({afk: true}),
		});
		expect({body: await response.json(), status: response.status}).toStrictEqual({
			body: {error: "pairing_required", message: "Pair a machine before turning AFK on."},
			status: 409,
		});
	});

	it("flips off and back on", async () => {
		const token = await registerMachineToken("afk-flip");
		const offResponse = await putAfk(token, false);
		expect(offResponse.status).toBe(200);
		expect(await offResponse.json()).toStrictEqual({afk: false});
		expect(await getAfk(token)).toStrictEqual({status: 200, afk: false});

		const onResponse = await putAfk(token, true);
		expect(onResponse.status).toBe(200);
		expect(await getAfk(token)).toStrictEqual({status: 200, afk: true});
	});

	it("rejects a malformed body", async () => {
		const token = await registerMachineToken("afk-bad-body");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
			method: "PUT",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({afk: "sideways"}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects new batches while off, teaching the model to use AskUserQuestion", async () => {
		const token = await registerMachineToken("afk-gate");
		await putAfk(token, false);
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: [{title: "Ship?", body: ""}]}),
		});
		expect(response.status).toBe(409);
		const body = await response.json<{error: string; message: string}>();
		expect(body.error).toBe("afk_off");
		expect(body.message).toContain("AskUserQuestion");
	});

	it("leaves pending cards answerable after flipping off", async () => {
		const token = await registerMachineToken("afk-pending");
		const created = await createBatchOverHttp(token, "demo", [{title: "Still here?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		await putAfk(token, false);

		const listResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = await listResponse.json<{current_deck: Array<{question_id: string}>}>();
		expect(listed.current_deck.map((question) => question.question_id)).toStrictEqual([questionId]);

		const answered = await postAnswers(token, [{question_id: questionId, disposition: "yep"}]);
		expect(answered.status).toBe(200);
	});

	it("forces AFK off and broadcasts state after the last machine is revoked", async () => {
		const userId = "afk-last-machine-revoked";
		const token = await registerMachineToken(userId);
		const streamResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {Authorization: `Bearer ${token}`, Upgrade: "websocket"},
		});
		const socket = required(streamResponse.webSocket ?? undefined, "question websocket");
		const initial = nextMessage(socket);
		socket.accept();
		expect(JSON.parse(await initial)).toStrictEqual({
			type: "current_deck",
			afk: true,
			paired: true,
			machine_count: 1,
			current_deck: [],
		});

		const refreshed = nextMessage(socket);
		const machine = await env.DB.prepare("SELECT id FROM machine_tokens WHERE user_id = ?")
			.bind(userId)
			.first<{id: string}>();
		expect(
			await revokeMachineToken(
				env.DB,
				env.USER_DO,
				userId,
				required(machine?.id, "machine id"),
				Date.UTC(2000, 0, 1),
			),
		).toBe(true);
		expect(JSON.parse(await refreshed)).toStrictEqual({
			type: "current_deck",
			afk: false,
			paired: false,
			machine_count: 0,
			current_deck: [],
		});
		expect(await env.USER_DO.getByName(userId).getAfk(false)).toBe(false);
		socket.close();
	});
});
