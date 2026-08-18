import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
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

	it("chunks and reconstructs a UTF-8 event without losing bytes", () => {
		const captured = capture();
		const context = createObservationContext("test.chunking", "chunk-correlation", captured.sink);
		const input = {binary: Uint8Array.of(0, 128, 255), text: "🧪".repeat(20_000)};
		const lines = emitObservation(context, "test.large", "output", input);
		const event = reconstructObservation(lines);

		expect({
			chunks: lines.length,
			component: event.component,
			correlationId: event.correlation_id,
			data: decodedObservationData(event),
			operation: event.operation,
			phase: event.phase,
			schema: event.schema,
		}).toStrictEqual({
			chunks: 4,
			component: "test.chunking",
			correlationId: "chunk-correlation",
			data: input,
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
					errorName: data instanceof Error ? data.name : (data as {error: Error}).error.name,
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

	it("does not consume HTTP bodies and captures RPC, email, and WebSocket boundaries", async () => {
		const captured = capture();
		const context = createObservationContext("test.transport", "transport-correlation", captured.sink);
		const request = new Request("https://example.com/api/v1/resource", {
			method: "POST",
			headers: {Authorization: "Bearer test-secret", "Content-Type": "application/octet-stream"},
			body: Uint8Array.of(0, 128, 255),
		});
		let handledBody: ArrayBuffer | undefined;
		const response = await observeHttpExchange(context, request, async () => {
			handledBody = await request.arrayBuffer();
			return new Response(Uint8Array.of(255, 128, 0), {
				status: 201,
				headers: {"X-Test-Response": "alice"},
			});
		});
		const responseBody = await response.arrayBuffer();

		const observedEnvironment = observeEnvironment(env, context);
		const object = observedEnvironment.USER_DO.getByName("observability-rpc-alice");
		const rpcResult = await object.setAfk(false, false);
		const emailResult = await observedEnvironment.EMAIL.send({
			to: "alice@example.com",
			from: {email: "accounts@yepnope.app", name: "Example Sender"},
			subject: "Observability test",
			text: "Test message body",
		});
		observeWebSocketFrame(context, "outbound", "beat");
		observeWebSocketFrame(context, "inbound", Uint8Array.of(0, 128, 255).buffer);

		expect({
			emailMessageIdType: typeof emailResult.messageId,
			handledBody: handledBody === undefined ? undefined : new Uint8Array(handledBody),
			responseBody: new Uint8Array(responseBody),
			responseStatus: response.status,
			rpcResult,
		}).toStrictEqual({
			emailMessageIdType: "string",
			handledBody: Uint8Array.of(0, 128, 255),
			responseBody: Uint8Array.of(255, 128, 0),
			responseStatus: 201,
			rpcResult: {status: "updated", afk: false},
		});
		const events = capturedEvents(captured.lines);
		expect(
			events
				.filter(({operation}) =>
					[
						"http.request",
						"http.response",
						"do.namespace.getByName",
						"do.rpc.setAfk",
						"email.send",
						"websocket.frame",
					].includes(operation),
				)
				.map(({severity, operation, phase}) => ({severity, operation, phase})),
		).toStrictEqual([
			{severity: "log", operation: "http.request", phase: "input"},
			{severity: "log", operation: "http.response", phase: "output"},
			{severity: "log", operation: "do.namespace.getByName", phase: "input"},
			{severity: "log", operation: "do.namespace.getByName", phase: "output"},
			{severity: "log", operation: "do.rpc.setAfk", phase: "input"},
			{severity: "log", operation: "do.rpc.setAfk", phase: "output"},
			{severity: "log", operation: "email.send", phase: "input"},
			{severity: "log", operation: "email.send", phase: "output"},
			{severity: "log", operation: "websocket.frame", phase: "outbound"},
			{severity: "log", operation: "websocket.frame", phase: "inbound"},
		]);
	});
});
