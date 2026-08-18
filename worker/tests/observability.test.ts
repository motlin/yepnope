import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import workerHandler from "../index";
import {
	createObservationContext,
	decodedObservationData,
	decodeObservedValue,
	emitObservation,
	encodeObservedValue,
	observeD1Database,
	observeDurableObjectStorage,
	observeEnvironment,
	observeHttpExchange,
	observeWebSocketFrame,
	reconstructObservation,
	type ObservationSink,
} from "../observability";
import type {UserDurableObject} from "../user-do";

interface CapturedLine {
	severity: "error" | "log";
	line: string;
}

interface CapturedEvent {
	severity: "error" | "log";
	operation: string;
	phase: string;
	data: unknown;
}

interface StoredObservation {
	operation: string;
	phase: string;
	metadata: {
		original_encoded_byte_length: number;
		retained_encoded_byte_length: number;
		data_truncated: boolean;
		event_dropped: boolean;
	};
	data: unknown;
}

function encodedByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function capture(): {lines: CapturedLine[]; sink: ObservationSink} {
	const lines: CapturedLine[] = [];
	return {
		lines,
		sink: (severity, line) => {
			lines.push({severity, line});
		},
	};
}

function capturedEvents(lines: CapturedLine[]): CapturedEvent[] {
	const grouped = new Map<string, CapturedLine[]>();
	for (const captured of lines) {
		const chunk = JSON.parse(captured.line) as {event_id: string};
		const eventLines = grouped.get(chunk.event_id) ?? [];
		eventLines.push(captured);
		grouped.set(chunk.event_id, eventLines);
	}
	return Array.from(grouped.values(), (eventLines) => {
		const event = reconstructObservation(eventLines.map(({line}) => line));
		return {
			severity: eventLines[0]?.severity ?? "log",
			operation: event.operation,
			phase: event.phase,
			data: decodedObservationData(event),
		};
	});
}

describe("yepnope.io.v1 event encoding", () => {
	it("round-trips special values, binary data, references, and errors", () => {
		const shared = {label: "alice"};
		const error = new Error("observability failed", {cause: new TypeError("invalid input")});
		Reflect.set(error, "code", "TEST_FAILURE");
		const original = {
			arrayBuffer: Uint8Array.of(0, 1, 127, 128, 255).buffer,
			bigint: 9_999_999n,
			date: new Date("2000-01-01T00:00:00.000Z"),
			error,
			map: new Map([["owner", shared]]),
			numbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
			references: [shared, shared],
			set: new Set(["yep", "nope"]),
			typedArray: new Uint16Array([0, 1000, 65_535]),
			undefined,
		};
		const decoded = decodeObservedValue(encodeObservedValue(original)) as typeof original;

		expect(encodeObservedValue(decoded)).toStrictEqual(encodeObservedValue(original));
		expect(decoded.references[0] === decoded.references[1]).toBe(true);
	});

	it("serializes supported platform values and labels unsupported objects", () => {
		const headers = new Headers();
		headers.append("X-Bob", "second");
		headers.append("X-Alice", "first");
		const url = new URL("https://example.com/api/v1/resource?answer=yep#details");
		const durableObjectId = env.USER_DO.idFromName("observability-platform-alice");

		expect(
			decodeObservedValue(
				encodeObservedValue({durableObjectId, headers, unsupported: new ReadableStream(), url}),
			),
		).toStrictEqual({
			durableObjectId: {kind: "durable_object_id", value: durableObjectId.toString()},
			headers: {
				kind: "headers",
				entries: [
					["x-alice", "first"],
					["x-bob", "second"],
				],
			},
			unsupported: {
				kind: "unsupported",
				type: "ReadableStream",
				reason: "unsupported_platform_object",
			},
			url: {kind: "url", href: "https://example.com/api/v1/resource?answer=yep#details"},
		});
	});

	it("redacts payloads before encoding one structured line", () => {
		const captured = capture();
		const context = createObservationContext("test.chunking", "chunk-correlation", captured.sink);
		const input = {binary: Uint8Array.of(0, 128, 255), text: "🧪".repeat(20_000)};
		const lines = emitObservation(context, "test.large", "output", input);
		const event = reconstructObservation(lines);

		expect({
			lines: lines.length,
			component: event.component,
			correlationId: event.correlation_id,
			data: decodedObservationData(event),
			metadata: event.metadata,
			operation: event.operation,
			phase: event.phase,
			schema: event.schema,
		}).toStrictEqual({
			lines: 1,
			component: "test.chunking",
			correlationId: "chunk-correlation",
			data: {kind: "object"},
			metadata: {
				original_encoded_byte_length: encodedByteLength(JSON.stringify(encodeObservedValue({kind: "object"}))),
				retained_encoded_byte_length: encodedByteLength(JSON.stringify(encodeObservedValue({kind: "object"}))),
				data_truncated: false,
				event_dropped: false,
			},
			operation: "test.large",
			phase: "output",
			schema: "yepnope.io.v1",
		});
	});
});

describe("D1 binding observation", () => {
	it("captures statements, bindings, rows, metadata, batches, sessions, and failures", async () => {
		const captured = capture();
		const database = observeD1Database(
			env.DB,
			createObservationContext("test.d1", "d1-correlation", captured.sink),
		);

		const all = await database
			.prepare("SELECT ? AS value UNION ALL SELECT ? AS value")
			.bind(100, 1000)
			.all<{value: number}>();
		const first = await database.prepare("SELECT 100 AS value").first<{value: number}>();
		const raw = await database.prepare("SELECT 100 AS value").raw({columnNames: true});
		const run = await database.prepare("SELECT 100 AS value").run<{value: number}>();
		const batch = await database.batch([
			database.prepare("SELECT ? AS value").bind(100),
			database.prepare("SELECT ? AS value").bind(1000),
		]);
		const exec = await database.exec("SELECT 100 AS value;");
		const session = database.withSession("first-primary");
		const sessionResult = await session.prepare("SELECT ? AS value").bind(100).all<{value: number}>();
		const sessionBatch = await session.batch([
			session.prepare("SELECT ? AS value").bind(100),
			session.prepare("SELECT ? AS value").bind(1000),
		]);
		const bookmark = session.getBookmark();
		let dumpResult: "failure" | "success" = "success";
		try {
			// oxlint-disable-next-line typescript/no-deprecated -- The wrapper must cover the complete D1 binding surface.
			await database.dump();
		} catch {
			dumpResult = "failure";
		}
		await expect(database.prepare("SELECT * FROM table_that_does_not_exist").all()).rejects.toThrow(
			"D1_ERROR: no such table: table_that_does_not_exist: SQLITE_ERROR",
		);

		expect({
			all: all.results,
			batch: batch.map(({results}) => results),
			bookmarkType: typeof bookmark,
			dumpResult,
			execCount: exec.count,
			first,
			raw,
			run: run.results,
			session: sessionResult.results,
			sessionBatch: sessionBatch.map(({results}) => results),
		}).toStrictEqual({
			all: [{value: 100}, {value: 1000}],
			batch: [[{value: 100}], [{value: 1000}]],
			bookmarkType: "string",
			dumpResult: "failure",
			execCount: 1,
			first: {value: 100},
			raw: [["value"], [100]],
			run: [{value: 100}],
			session: [{value: 100}],
			sessionBatch: [[{value: 100}], [{value: 1000}]],
		});

		const events = capturedEvents(captured.lines);
		expect(
			events
				.filter(({operation, phase}) => operation.startsWith("d1.") && phase === "failure")
				.map(({severity, operation, phase, data}) => ({
					severity,
					operation,
					phase,
					errorName: (data as {name: string}).name,
				})),
		).toStrictEqual([
			{severity: "error", operation: "d1.dump", phase: "failure", errorName: "Error"},
			{severity: "error", operation: "d1.statement.all", phase: "failure", errorName: "Error"},
		]);
		expect(new Set(events.map(({operation}) => operation))).toStrictEqual(
			new Set([
				"d1.prepare",
				"d1.statement.bind",
				"d1.statement.all",
				"d1.statement.first",
				"d1.statement.raw",
				"d1.statement.run",
				"d1.batch",
				"d1.exec",
				"d1.with_session",
				"d1.session.prepare",
				"d1.session.batch",
				"d1.session.get_bookmark",
				"d1.dump",
			]),
		);
	});
});

describe("Durable Object and transport observation", () => {
	it("bounds 256 KiB request bodies, records drops, and preserves later responses", async () => {
		const captured = capture();
		const context = createObservationContext("test.ordinary-body", "ordinary-body-correlation", captured.sink);
		const body = new Uint8Array(256 * 1024).fill(65);

		for (let index = 0; index < 9; index += 1) {
			const response = await observeHttpExchange(
				context,
				new Request(`https://example.com/api/v1/ordinary/${index}`, {method: "POST", body}),
				async (request) => {
					await request.arrayBuffer();
					return new Response(`response-${index}`);
				},
			);
			await response.arrayBuffer();
		}

		const lineByteLengths = captured.lines.map(({line}) => encodedByteLength(line));
		const observations = captured.lines.map(({line}) => JSON.parse(line) as StoredObservation);
		const requestObservations = observations.filter(({operation}) => operation === "http.request");
		const responseEvents = capturedEvents(captured.lines).filter(({operation}) => operation === "http.response");
		const firstRequest = requestObservations[0];
		const droppedRequest = requestObservations.find(({metadata}) => metadata.event_dropped);
		if (
			firstRequest === undefined ||
			droppedRequest === undefined ||
			typeof firstRequest.data !== "object" ||
			firstRequest.data === null ||
			typeof Reflect.get(firstRequest.data, "value") !== "string"
		) {
			throw new Error("expected truncated and dropped request observations");
		}
		const firstRetainedBytes = atob(Reflect.get(firstRequest.data, "value") as string).length;
		const expectedOriginalBytes = encodedByteLength(
			JSON.stringify(
				encodeObservedValue({
					body: body.buffer,
					bodyTruncated: false,
					headers: [],
					method: "POST",
					url: "https://example.com/api/v1/ordinary/0",
				}),
			),
		);

		expect(Math.max(...lineByteLengths)).toBeLessThanOrEqual(24 * 1024);
		expect(lineByteLengths.reduce((total, byteLength) => total + byteLength, 0)).toBeLessThanOrEqual(256 * 1024);
		expect({
			firstRequest: {
				dataKind: Reflect.get(firstRequest.data, "kind"),
				metadata: firstRequest.metadata,
				retainedPrefixBytes: firstRetainedBytes,
			},
			droppedRequest: {
				data: droppedRequest.data,
				metadata: droppedRequest.metadata,
			},
			lineCount: observations.length,
			responses: responseEvents.map(({operation, phase, data}) => ({operation, phase, data})),
		}).toStrictEqual({
			firstRequest: {
				dataKind: "truncated",
				metadata: {
					original_encoded_byte_length: expectedOriginalBytes,
					retained_encoded_byte_length: firstRetainedBytes,
					data_truncated: true,
					event_dropped: false,
				},
				retainedPrefixBytes: firstRetainedBytes,
			},
			droppedRequest: {
				data: {kind: "dropped", original_kind: "object"},
				metadata: {
					original_encoded_byte_length: expectedOriginalBytes,
					retained_encoded_byte_length: 0,
					data_truncated: false,
					event_dropped: true,
				},
			},
			lineCount: 18,
			responses: Array.from({length: 9}, (_, index) => ({
				operation: "http.response",
				phase: "output",
				data: {
					body: new TextEncoder().encode(`response-${index}`).buffer,
					bodyTruncated: false,
					headers: [["content-type", "text/plain;charset=UTF-8"]],
					status: 200,
					statusText: "OK",
					webSocket: false,
				},
			})),
		});
	});

	it("bounds a 1 MiB hook body and preserves a later failure event", async () => {
		const captured = capture();
		const context = createObservationContext("test.hook-body", "hook-body-correlation", captured.sink);
		const body = new Uint8Array(1024 * 1024).fill(66);
		const failure = new Error("test hook handler failure");

		await expect(
			observeHttpExchange(
				context,
				new Request("https://example.com/api/v1/hook", {method: "POST", body}),
				async (request) => {
					await request.arrayBuffer();
					throw failure;
				},
			),
		).rejects.toThrow("test hook handler failure");

		const lineByteLengths = captured.lines.map(({line}) => encodedByteLength(line));
		const observations = captured.lines.map(({line}) => JSON.parse(line) as StoredObservation);
		const request = observations.find(({operation}) => operation === "http.request");
		const failureEvent = capturedEvents(captured.lines).find(
			({operation, phase}) => operation === "http.exchange" && phase === "failure",
		);
		if (
			request === undefined ||
			typeof request.data !== "object" ||
			request.data === null ||
			typeof Reflect.get(request.data, "value") !== "string"
		) {
			throw new Error("expected a hook request observation");
		}
		const retainedRequestBytes = atob(Reflect.get(request.data, "value") as string).length;

		expect(Math.max(...lineByteLengths)).toBeLessThanOrEqual(24 * 1024);
		expect(lineByteLengths.reduce((total, byteLength) => total + byteLength, 0)).toBeLessThanOrEqual(256 * 1024);
		expect({
			lineCount: observations.length,
			request: {
				dataKind: Reflect.get(request.data, "kind"),
				metadata: request.metadata,
			},
			failure:
				failureEvent === undefined
					? undefined
					: {
							severity: failureEvent.severity,
							operation: failureEvent.operation,
							phase: failureEvent.phase,
							data:
								failureEvent.data instanceof Error
									? {name: failureEvent.data.name, message: failureEvent.data.message}
									: failureEvent.data,
						},
		}).toStrictEqual({
			lineCount: 2,
			request: {
				dataKind: "truncated",
				metadata: {
					original_encoded_byte_length: encodedByteLength(
						JSON.stringify(
							encodeObservedValue({
								body: body.buffer,
								bodyTruncated: false,
								headers: [],
								method: "POST",
								url: "https://example.com/api/v1/hook",
							}),
						),
					),
					retained_encoded_byte_length: retainedRequestBytes,
					data_truncated: true,
					event_dropped: false,
				},
			},
			failure: {
				severity: "error",
				operation: "http.exchange",
				phase: "failure",
				data: {kind: "error", name: "Error"},
			},
		});
	});

	it("preserves SQL cursors, storage operations, and transaction behavior", async () => {
		const captured = capture();
		const stub = env.USER_DO.getByName("observability-storage-alice");
		const result = await runInDurableObject(stub, async (_instance: UserDurableObject, state) => {
			const storage = observeDurableObjectStorage(
				state.storage,
				createObservationContext("test.storage", "storage-correlation", captured.sink),
			);
			await storage.put("alice-key", {answer: "yep"});
			const stored = await storage.get("alice-key");
			await storage.transaction(async (transaction) => {
				await transaction.put("bob-key", "nope");
				return transaction.get("bob-key");
			});
			const listed = await storage.list({prefix: "alice"});
			storage.kv.put("charlie-key", 1000);
			const synchronous = storage.kv.get("charlie-key");

			storage.transactionSync(() => {
				storage.sql.exec("CREATE TABLE observation_values (value INTEGER NOT NULL)").toArray();
				storage.sql.exec("INSERT INTO observation_values (value) VALUES (?), (?)", 100, 1000).toArray();
			});
			const arrayRows = storage.sql
				.exec<{value: number}>("SELECT value FROM observation_values ORDER BY value")
				.toArray();
			const oneRow = storage.sql.exec<{value: number}>("SELECT value FROM observation_values LIMIT 1").one();
			const iteratedRows = Array.from(
				storage.sql.exec<{value: number}>("SELECT value FROM observation_values ORDER BY value"),
			);
			const rawRows = Array.from(
				storage.sql.exec("SELECT value FROM observation_values ORDER BY value").raw<[number]>(),
			);
			let sqlFailure = "";
			try {
				storage.sql.exec("SELECT * FROM table_that_does_not_exist").toArray();
			} catch (error) {
				sqlFailure = error instanceof Error ? error.name : "unknown";
			}
			await storage.setAlarm(new Date("2099-12-31T00:00:00.000Z"));
			const alarm = await storage.getAlarm();
			await storage.deleteAlarm();
			await storage.delete(["alice-key", "bob-key"]);
			storage.kv.delete("charlie-key");
			await storage.deleteAll();
			return {alarm, arrayRows, iteratedRows, listed, oneRow, rawRows, sqlFailure, stored, synchronous};
		});

		expect(result).toStrictEqual({
			alarm: Date.parse("2099-12-31T00:00:00.000Z"),
			arrayRows: [{value: 100}, {value: 1000}],
			iteratedRows: [{value: 100}, {value: 1000}],
			listed: new Map([["alice-key", {answer: "yep"}]]),
			oneRow: {value: 100},
			rawRows: [[100], [1000]],
			sqlFailure: "Error",
			stored: {answer: "yep"},
			synchronous: 1000,
		});
		const events = capturedEvents(captured.lines);
		expect(new Set(events.map(({operation}) => operation))).toStrictEqual(
			new Set([
				"do.storage.put",
				"do.storage.get",
				"do.storage.transaction",
				"do.storage.transaction.put",
				"do.storage.transaction.get",
				"do.storage.list",
				"do.storage.kv.put",
				"do.storage.kv.get",
				"do.storage.kv.delete",
				"do.storage.transaction_sync",
				"do.sql.exec",
				"do.sql.cursor.toArray",
				"do.sql.cursor.one",
				"do.sql.cursor.iterator.next.next",
				"do.sql.cursor.raw.next.next",
				"do.storage.setAlarm",
				"do.storage.getAlarm",
				"do.storage.deleteAlarm",
				"do.storage.delete",
				"do.storage.deleteAll",
			]),
		);
		expect(
			events
				.filter(({phase}) => phase === "failure")
				.map(({severity, operation, phase}) => ({severity, operation, phase})),
		).toStrictEqual([{severity: "error", operation: "do.sql.exec", phase: "failure"}]);
	});

	it("returns an open-ended streaming response before EOF", async () => {
		const captured = capture();
		const context = createObservationContext("test.streaming", "streaming-correlation", captured.sink);
		let bodyController!: ReadableStreamDefaultController<Uint8Array>;
		const streamingResponse = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller;
					controller.enqueue(Uint8Array.of(0, 128, 255));
				},
			}),
			{status: 200},
		);
		const response = await observeHttpExchange(
			context,
			new Request("https://example.com/api/v1/stream"),
			async () => Promise.resolve(streamingResponse),
		);
		const reader = response.body?.getReader();
		if (reader === undefined) {
			throw new Error("streaming response body is missing");
		}
		const first = await reader.read();

		expect({
			first,
			responseEvents: capturedEvents(captured.lines).filter(({operation}) => operation === "http.response"),
		}).toStrictEqual({
			first: {done: false, value: Uint8Array.of(0, 128, 255)},
			responseEvents: [],
		});

		bodyController.close();
		expect(await reader.read()).toStrictEqual({done: true, value: undefined});
		expect(
			capturedEvents(captured.lines)
				.filter(({operation}) => operation === "http.response")
				.map(({severity, operation, phase, data}) => ({severity, operation, phase, data})),
		).toStrictEqual([
			{
				severity: "log",
				operation: "http.response",
				phase: "output",
				data: {
					body: Uint8Array.of(0, 128, 255).buffer,
					bodyTruncated: false,
					headers: [],
					status: 200,
					statusText: "OK",
					webSocket: false,
				},
			},
		]);
	});

	it("rejects an oversized request before reading its body", async () => {
		let bodyReads = 0;
		const request = new Request("https://example.com/api/v1/questions", {
			method: "POST",
			headers: {"Content-Length": String(1024 * 1024)},
			body: new ReadableStream<Uint8Array>(
				{
					pull() {
						bodyReads += 1;
						throw new Error("oversized request body was read");
					},
				},
				{highWaterMark: 0},
			),
		});

		const response = await workerHandler.fetch(
			request as Parameters<typeof workerHandler.fetch>[0],
			env,
			undefined as never,
		);

		expect({bodyReads, status: response.status}).toStrictEqual({bodyReads: 0, status: 413});
	});

	it("reconstructs finite binary HTTP bodies and captures RPC, email, and WebSocket boundaries", async () => {
		const captured = capture();
		const context = createObservationContext("test.transport", "transport-correlation", captured.sink);
		const requestBody = Uint8Array.of(0, 128, 255);
		const responseBody = Uint8Array.of(255, 128, 0);
		const request = new Request("https://example.com/api/v1/resource", {
			method: "POST",
			headers: {"Content-Type": "application/octet-stream"},
			body: requestBody,
		});
		let handledBody: ArrayBuffer | undefined;
		const response = await observeHttpExchange(context, request, async (request) => {
			handledBody = await request.arrayBuffer();
			return new Response(responseBody, {
				status: 201,
				headers: {"X-Test-Response": "alice"},
			});
		});
		const deliveredResponseBody = await response.arrayBuffer();

		const deliveredMessages: Array<EmailMessage | EmailMessageBuilder> = [];
		const email: SendEmail = {
			send: async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
				deliveredMessages.push(message);
				return Promise.resolve({messageId: `test-message-${deliveredMessages.length}`});
			},
		};
		const observedEnvironment = observeEnvironment({DB: env.DB, EMAIL: email, USER_DO: env.USER_DO}, context);
		const namedId = observedEnvironment.USER_DO.idFromName("observability-id-alice");
		const parsedId = observedEnvironment.USER_DO.idFromString(namedId.toString());
		const uniqueId = observedEnvironment.USER_DO.newUniqueId();
		const namedObject = observedEnvironment.USER_DO.get(namedId);
		const object = observedEnvironment.USER_DO.getByName("observability-rpc-alice");
		const rpcResult = await object.setAfk(false, false);
		const emailResult = await observedEnvironment.EMAIL.send({
			to: ["alice@example.com", {email: "bob@example.com", name: "Bob"}],
			cc: "charlie@example.com",
			bcc: {email: "dana@example.com", name: "Dana"},
			from: {email: "accounts@yepnope.app", name: "Example Sender"},
			subject: "Reset your password",
			replyTo: {email: "support@example.com", name: "Example Support"},
			headers: {"X-Example-Category": "authentication"},
			text: "Use https://example.com/reset-password?token=fake-reset-token",
			html: '<p>Use <a href="https://example.com/reset-password?token=fake-reset-token">this link</a></p>',
			attachments: [
				{
					disposition: "inline",
					contentId: "example-logo",
					filename: "logo.txt",
					type: "text/plain",
					content: "example inline attachment",
				},
				{
					disposition: "attachment",
					filename: "codes.bin",
					type: "application/octet-stream",
					content: Uint8Array.of(0, 128, 255),
				},
			],
		});
		const rawEmail: EmailMessage = {from: "accounts@yepnope.app", to: "alice@example.com"};
		const rawEmailResult = await observedEnvironment.EMAIL.send(rawEmail);
		observeWebSocketFrame(
			context,
			"outbound",
			JSON.stringify({body: "Private question context", title: "Private question?"}),
		);
		observeWebSocketFrame(context, "inbound", Uint8Array.of(0, 128, 255).buffer);

		expect({
			emailMessageIdType: typeof emailResult.messageId,
			namedObjectId: namedObject.id.toString(),
			parsedId: parsedId.toString(),
			rawEmailMessageId: rawEmailResult.messageId,
			handledBody: handledBody === undefined ? undefined : new Uint8Array(handledBody),
			responseBody: new Uint8Array(deliveredResponseBody),
			responseStatus: response.status,
			rpcResult,
			uniqueId: uniqueId.toString(),
		}).toStrictEqual({
			emailMessageIdType: "string",
			namedObjectId: namedId.toString(),
			parsedId: namedId.toString(),
			rawEmailMessageId: "test-message-2",
			handledBody: requestBody,
			responseBody,
			responseStatus: 201,
			rpcResult: {status: "updated", afk: false},
			uniqueId: uniqueId.toString(),
		});
		const events = capturedEvents(captured.lines);
		expect(
			events
				.filter(({operation}) => operation === "http.request" || operation === "http.response")
				.map(({severity, operation, phase, data}) => ({severity, operation, phase, data})),
		).toStrictEqual([
			{
				severity: "log",
				operation: "http.request",
				phase: "input",
				data: {
					body: requestBody.buffer,
					bodyTruncated: false,
					headers: [["content-type", "application/octet-stream"]],
					method: "POST",
					url: "https://example.com/api/v1/resource",
				},
			},
			{
				severity: "log",
				operation: "http.response",
				phase: "output",
				data: {
					body: responseBody.buffer,
					bodyTruncated: false,
					headers: [["x-test-response", "alice"]],
					status: 201,
					statusText: "Created",
					webSocket: false,
				},
			},
		]);
		expect(
			events
				.filter(({operation}) =>
					[
						"do.namespace.idFromName",
						"do.namespace.idFromString",
						"do.namespace.newUniqueId",
						"do.namespace.get",
						"do.namespace.getByName",
						"do.rpc.setAfk",
						"email.send",
						"websocket.frame",
					].includes(operation),
				)
				.map(({severity, operation, phase, data}) => ({severity, operation, phase, data})),
		).toStrictEqual([
			{
				severity: "log",
				operation: "do.namespace.idFromName",
				phase: "input",
				data: {arguments: ["observability-id-alice"]},
			},
			{
				severity: "log",
				operation: "do.namespace.idFromName",
				phase: "output",
				data: {kind: "durable_object_id", value: namedId.toString()},
			},
			{
				severity: "log",
				operation: "do.namespace.idFromString",
				phase: "input",
				data: {arguments: [namedId.toString()]},
			},
			{
				severity: "log",
				operation: "do.namespace.idFromString",
				phase: "output",
				data: {kind: "durable_object_id", value: namedId.toString()},
			},
			{
				severity: "log",
				operation: "do.namespace.newUniqueId",
				phase: "input",
				data: {arguments: []},
			},
			{
				severity: "log",
				operation: "do.namespace.newUniqueId",
				phase: "output",
				data: {kind: "durable_object_id", value: uniqueId.toString()},
			},
			{
				severity: "log",
				operation: "do.namespace.get",
				phase: "input",
				data: {arguments: [{kind: "durable_object_id", value: namedId.toString()}]},
			},
			{
				severity: "log",
				operation: "do.namespace.get",
				phase: "output",
				data: {id: namedId.toString(), name: "observability-id-alice"},
			},
			{
				severity: "log",
				operation: "do.namespace.getByName",
				phase: "input",
				data: {arguments: ["observability-rpc-alice"]},
			},
			{
				severity: "log",
				operation: "do.namespace.getByName",
				phase: "output",
				data: {id: object.id.toString(), name: "observability-rpc-alice"},
			},
			{severity: "log", operation: "do.rpc.setAfk", phase: "input", data: {kind: "object"}},
			{severity: "log", operation: "do.rpc.setAfk", phase: "output", data: {kind: "object"}},
			{
				severity: "log",
				operation: "email.send",
				phase: "input",
				data: {
					arguments: [
						{
							kind: "email_message_builder",
							fields: {
								attachments: [
									{
										disposition: "inline",
										contentId: "example-logo",
										filename: "logo.txt",
										type: "text/plain",
										content: "example inline attachment",
									},
									{
										disposition: "attachment",
										filename: "codes.bin",
										type: "application/octet-stream",
										content: Uint8Array.of(0, 128, 255),
									},
								],
								bcc: {email: "dana@example.com", name: "Dana"},
								cc: "charlie@example.com",
								from: {email: "accounts@yepnope.app", name: "Example Sender"},
								headers: {"X-Example-Category": "authentication"},
								html: '<p>Use <a href="https://example.com/reset-password?token=fake-reset-token">this link</a></p>',
								replyTo: {email: "support@example.com", name: "Example Support"},
								subject: "Reset your password",
								text: "Use https://example.com/reset-password?token=fake-reset-token",
								to: ["alice@example.com", {email: "bob@example.com", name: "Bob"}],
							},
						},
					],
				},
			},
			{
				severity: "log",
				operation: "email.send",
				phase: "output",
				data: {messageId: "test-message-1"},
			},
			{
				severity: "log",
				operation: "email.send",
				phase: "input",
				data: {
					arguments: [
						{
							kind: "email_message",
							envelope: {from: "accounts@yepnope.app", to: "alice@example.com"},
							content: {
								available: false,
								reason: "raw_mime_not_exposed_by_send_binding",
							},
						},
					],
				},
			},
			{
				severity: "log",
				operation: "email.send",
				phase: "output",
				data: {messageId: "test-message-2"},
			},
			{severity: "log", operation: "websocket.frame", phase: "outbound", data: {kind: "string"}},
			{severity: "log", operation: "websocket.frame", phase: "inbound", data: {kind: "array_buffer"}},
		]);
	});

	it("preserves response delivery when capture emission fails", async () => {
		const lines: CapturedLine[] = [];
		let responseCaptureFailed = false;
		const sink: ObservationSink = (severity, line) => {
			const chunk = JSON.parse(line) as {operation: string};
			if (chunk.operation === "http.response" && !responseCaptureFailed) {
				responseCaptureFailed = true;
				throw new Error("test observation sink failure");
			}
			lines.push({severity, line});
		};
		const response = await observeHttpExchange(
			createObservationContext("test.capture-failure", "capture-failure-correlation", sink),
			new Request("https://example.com/api/v1/resource"),
			async () => Promise.resolve(new Response(Uint8Array.of(0, 128, 255))),
		);

		expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(Uint8Array.of(0, 128, 255));
		expect(
			capturedEvents(lines)
				.filter(({operation}) => operation === "http.response.capture")
				.map(({severity, operation, phase, data}) => ({
					severity,
					operation,
					phase,
					error: data instanceof Error ? {name: data.name, message: data.message} : data,
				})),
		).toStrictEqual([
			{
				severity: "error",
				operation: "http.response.capture",
				phase: "failure",
				error: {name: "Error", message: "test observation sink failure"},
			},
		]);
	});
});
