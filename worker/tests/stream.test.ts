import {describe, expect, it} from "vitest";
import type {Frame} from "../protocol";
import {
	API_ORIGIN,
	createBatchOverHttp,
	nextMessage,
	postAnswers,
	registerMachineToken,
	required,
	worker,
} from "./helpers";

async function openStream(token: string, batchId: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/questions/${batchId}/stream`, {
		headers: {Authorization: `Bearer ${token}`, Upgrade: "websocket"},
	});
}

function acceptedSocket(response: Response): WebSocket {
	const socket = required(response.webSocket ?? undefined, "websocket on the upgrade response");
	return socket;
}

describe("GET /api/v1/questions/:batch_id/stream", () => {
	it("requires a websocket upgrade", async () => {
		const token = await registerMachineToken("stream-no-upgrade");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship?", body: ""}]);
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions/${created.batch_id}/stream`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		expect(response.status).toBe(426);
	});

	it("returns 404 for an unknown batch", async () => {
		const token = await registerMachineToken("stream-unknown-batch");
		const response = await openStream(token, crypto.randomUUID());
		expect(response.status).toBe(404);
	});

	it("sends a full state frame on connect", async () => {
		const token = await registerMachineToken("stream-initial");
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: ""},
			{title: "Second?", body: ""},
		]);
		const firstQuestionId = required(created.question_ids[0], "first question id");
		const secondQuestionId = required(created.question_ids[1], "second question id");
		const response = await openStream(token, created.batch_id);
		expect(response.status).toBe(101);
		const socket = acceptedSocket(response);
		const initialFrame = nextMessage(socket);
		socket.accept();

		const frame = JSON.parse(await initialFrame) as Frame;
		expect(frame).toEqual({
			type: "state",
			batch_id: created.batch_id,
			dispositions: {[firstQuestionId]: null, [secondQuestionId]: null},
		});
		socket.close();
	});

	it("pushes state on each answer and resolved when the batch completes", async () => {
		const token = await registerMachineToken("stream-resolve");
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: ""},
			{title: "Second?", body: ""},
		]);
		const firstQuestionId = required(created.question_ids[0], "first question id");
		const secondQuestionId = required(created.question_ids[1], "second question id");
		const response = await openStream(token, created.batch_id);
		const socket = acceptedSocket(response);
		const initialFrame = nextMessage(socket);
		socket.accept();
		await initialFrame;

		const afterFirstAnswer = nextMessage(socket);
		await postAnswers(token, [{question_id: firstQuestionId, disposition: "yep"}]);
		const stateAfterFirst = JSON.parse(await afterFirstAnswer) as Frame;
		expect(stateAfterFirst).toEqual({
			type: "state",
			batch_id: created.batch_id,
			dispositions: {[firstQuestionId]: "yep", [secondQuestionId]: null},
		});

		const afterSecondAnswer = nextMessage(socket);
		await postAnswers(token, [{question_id: secondQuestionId, disposition: "nope"}]);
		const resolved = JSON.parse(await afterSecondAnswer) as Frame;
		expect(resolved).toEqual({
			type: "resolved",
			batch_id: created.batch_id,
			dispositions: {[firstQuestionId]: "yep", [secondQuestionId]: "nope"},
		});
	});

	it("sends resolved immediately when connecting to an already answered batch", async () => {
		const token = await registerMachineToken("stream-already-resolved");
		const created = await createBatchOverHttp(token, "demo", [{title: "Done?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		await postAnswers(token, [{question_id: questionId, disposition: "yep"}]);

		const response = await openStream(token, created.batch_id);
		const socket = acceptedSocket(response);
		const initialFrame = nextMessage(socket);
		socket.accept();
		const frame = JSON.parse(await initialFrame) as Frame;
		expect(frame.type).toBe("resolved");
	});

	it("answers heartbeats with the current full state", async () => {
		const token = await registerMachineToken("stream-heartbeat");
		const created = await createBatchOverHttp(token, "demo", [{title: "Alive?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		const response = await openStream(token, created.batch_id);
		const socket = acceptedSocket(response);
		const initialFrame = nextMessage(socket);
		socket.accept();
		await initialFrame;

		const heartbeatReply = nextMessage(socket);
		socket.send("beat");
		const frame = JSON.parse(await heartbeatReply) as Frame;
		expect(frame).toEqual({
			type: "state",
			batch_id: created.batch_id,
			dispositions: {[questionId]: null},
		});
		socket.close();
	});
});
