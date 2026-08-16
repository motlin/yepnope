import {authenticateMachineToken} from "./auth";
import type {UserDurableObject} from "./user-do";
import {createBatchRequestSchema, MAX_REQUEST_BYTES, submitAnswersRequestSchema} from "./validation";

export {UserDurableObject} from "./user-do";

const STREAM_PATH = /^\/api\/v1\/questions\/[^/]+\/stream$/;

export default {
	async fetch(request, env, executionContext): Promise<Response> {
		// 🛡️ Rude by design: reject on Content-Length before reading the body (spec §7.2).
		const contentLength = Number(request.headers.get("Content-Length") ?? "0");
		if (contentLength > MAX_REQUEST_BYTES) {
			return new Response(null, {status: 413});
		}

		const userId = await authenticateMachineToken(request, env.DB);
		if (userId === null) {
			return new Response(null, {status: 401});
		}
		const stub = env.USER_DO.getByName(userId);

		const url = new URL(request.url);
		if (request.method === "GET" && STREAM_PATH.test(url.pathname)) {
			return stub.fetch(request);
		}
		if (url.pathname === "/api/v1/questions" && request.method === "POST") {
			return createQuestions(request, stub, executionContext);
		}
		if (url.pathname === "/api/v1/questions" && request.method === "GET") {
			return listQuestions(stub);
		}
		if (url.pathname === "/api/v1/answers" && request.method === "POST") {
			return submitAnswers(request, stub);
		}
		return new Response(null, {status: 404});
	},
} satisfies ExportedHandler<Env>;

async function createQuestions(
	request: Request,
	stub: DurableObjectStub<UserDurableObject>,
	executionContext: ExecutionContext,
): Promise<Response> {
	const parsed = createBatchRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const created = await stub.createBatch(parsed.data);
	// 📣 One push per batch, sent outside the response path (spec §6.1/§6.2).
	executionContext.waitUntil(stub.sendBatchPush(created.batchId));
	return Response.json({batch_id: created.batchId, question_ids: created.questionIds}, {status: 201});
}

async function listQuestions(stub: DurableObjectStub<UserDurableObject>): Promise<Response> {
	const outstanding = await stub.getOutstandingQuestions();
	return Response.json({
		questions: outstanding.map((question) => ({
			batch_id: question.batchId,
			project: question.project,
			question_id: question.questionId,
			position: question.position,
			title: question.title,
			body: question.body,
			created_at: question.createdAt,
		})),
	});
}

async function submitAnswers(request: Request, stub: DurableObjectStub<UserDurableObject>): Promise<Response> {
	const parsed = submitAnswersRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	try {
		await stub.submitAnswers(parsed.data.answers);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("unknown_question")) {
			return new Response(null, {status: 404});
		}
		if (error instanceof Error && error.message.startsWith("already_answered")) {
			return new Response(null, {status: 409});
		}
		if (error instanceof Error && error.message.startsWith("duplicate_question")) {
			return new Response(null, {status: 400});
		}
		throw error;
	}
	return Response.json({status: "ok"});
}
