/* oxlint-disable typescript/no-deprecated, typescript/no-redundant-type-constituents, typescript/no-unnecessary-condition, typescript/no-unnecessary-type-assertion, typescript/no-unnecessary-type-conversion, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-type-assertion, typescript/unified-signatures -- Cloudflare runtime bindings require reflective typed proxies. */

import {redactMachineTokens} from "./machine-token";

const OBSERVATION_SCHEMA = "yepnope.io.v1";
const OBSERVATION_LINE_BYTES = 24 * 1024;
const OBSERVATION_INVOCATION_BYTES = 256 * 1024;
const OBSERVATION_PRIORITY_RESERVE_BYTES = 64 * 1024;
const OBSERVATION_DROP_RESERVE_BYTES = 8 * 1024;
const OBSERVATION_LINE_SEPARATOR_BYTES = 1;
const OBSERVED_BODY_BYTES = 1024 * 1024;

type ObservationSeverity = "error" | "log";

export type ObservationSink = (severity: ObservationSeverity, line: string) => void;

export interface ObservationContext {
	component: string;
	correlationId: string;
	objectId?: string;
	sink?: ObservationSink;
	outputBudget: ObservationOutputBudget;
}

interface ObservationEvent {
	schema: typeof OBSERVATION_SCHEMA;
	event_id: string;
	correlation_id: string;
	component: string;
	object_id?: string;
	operation: string;
	phase: string;
	timestamp: number;
	metadata: ObservationMetadata;
	data: StoredObservedValue;
}

interface ObservationOutputBudget {
	emittedBytes: number;
}

interface ObservationMetadata {
	original_encoded_byte_length: number;
	retained_encoded_byte_length: number;
	data_truncated: boolean;
	event_dropped: boolean;
}

type StoredObservedValue = EncodedObservedValue | TruncatedObservedValue | DroppedObservedValue;

interface TruncatedObservedValue {
	kind: "truncated";
	original_kind: EncodedObservedValue["kind"];
	encoding: "base64";
	value: string;
}

interface DroppedObservedValue {
	kind: "dropped";
	original_kind: EncodedObservedValue["kind"];
}

type EncodedObservedValue =
	| {kind: "null"}
	| {kind: "undefined"}
	| {kind: "boolean"; value: boolean}
	| {kind: "string"; value: string}
	| {kind: "number"; value: string}
	| {kind: "bigint"; value: string}
	| {kind: "array"; id: number; value: EncodedObservedValue[]}
	| {kind: "object"; id: number; value: Array<[string, EncodedObservedValue]>}
	| {kind: "map"; id: number; value: Array<[EncodedObservedValue, EncodedObservedValue]>}
	| {kind: "set"; id: number; value: EncodedObservedValue[]}
	| {kind: "date"; id: number; value: string}
	| {
			kind: "error";
			id: number;
			name: string;
			message: string;
			stack?: string;
			cause: EncodedObservedValue;
			properties: Array<[string, EncodedObservedValue]>;
	  }
	| {kind: "array_buffer"; id: number; value: string}
	| {kind: "array_buffer_view"; id: number; view: string; value: string}
	| {kind: "durable_object_id"; id: number; value: string}
	| {kind: "headers"; id: number; value: Array<[string, string]>}
	| {kind: "url"; id: number; value: string}
	| {
			kind: "email_message";
			id: number;
			from: string;
			to: string;
			content: {available: false; reason: "raw_mime_not_exposed_by_send_binding"};
	  }
	| {kind: "email_message_builder"; id: number; value: Array<[string, EncodedObservedValue]>}
	| {kind: "unsupported"; id: number; type: string; reason: "unsupported_platform_object"}
	| {kind: "reference"; id: number};

type RedactedObservedValue =
	| {kind: "null"}
	| {kind: "undefined"}
	| {kind: "boolean"}
	| {kind: "string"}
	| {kind: "number"}
	| {kind: "bigint"}
	| {kind: "array"}
	| {kind: "object"}
	| {kind: "map"}
	| {kind: "set"}
	| {kind: "date"}
	| {kind: "error"; name: string}
	| {kind: "array_buffer"}
	| {kind: "array_buffer_view"; view: string};

const SAFE_ERROR_NAMES = new Set([
	"AggregateError",
	"Error",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
]);

function errorSummary(value: unknown): RedactedObservedValue | null {
	const error =
		value instanceof Error
			? value
			: typeof value === "object" && value !== null && Reflect.get(value, "error") instanceof Error
				? (Reflect.get(value, "error") as Error)
				: null;
	if (error === null) {
		return null;
	}
	return {kind: "error", name: SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error"};
}

function redactObservedValue(value: unknown): RedactedObservedValue {
	const error = errorSummary(value);
	if (error !== null) {
		return error;
	}
	if (value === null) {
		return {kind: "null"};
	}
	switch (typeof value) {
		case "undefined":
			return {kind: "undefined"};
		case "boolean":
			return {kind: "boolean"};
		case "string":
			return {kind: "string"};
		case "number":
			return {kind: "number"};
		case "bigint":
			return {kind: "bigint"};
		case "function":
		case "symbol":
			return {kind: "object"};
		case "object":
			break;
	}
	if (value instanceof ArrayBuffer) {
		return {kind: "array_buffer"};
	}
	if (ArrayBuffer.isView(value)) {
		return {kind: "array_buffer_view", view: value.constructor.name};
	}
	if (value instanceof Date) {
		return {kind: "date"};
	}
	if (Array.isArray(value)) {
		return {kind: "array"};
	}
	if (value instanceof Map) {
		return {kind: "map"};
	}
	if (value instanceof Set) {
		return {kind: "set"};
	}
	return {kind: "object"};
}

function defaultObservationSink(severity: ObservationSeverity, line: string): void {
	if (severity === "error") {
		console.error(line);
		return;
	}
	console.log(line);
}

export function createObservationContext(
	component: string,
	correlationId = crypto.randomUUID(),
	sink?: ObservationSink,
): ObservationContext {
	const outputBudget = {emittedBytes: 0};
	return sink === undefined
		? {component, correlationId, outputBudget}
		: {component, correlationId, sink, outputBudget};
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 16_384) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 16_384, bytes.length)));
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function redactMachineTokenBytes(bytes: Uint8Array): Uint8Array {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 16_384) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 16_384, bytes.length)));
	}
	const redacted = redactMachineTokens(binary);
	if (redacted === binary) {
		return bytes;
	}
	return Uint8Array.from(redacted, (character) => character.charCodeAt(0));
}

function encodeNumber(value: number): string {
	if (Number.isNaN(value)) {
		return "NaN";
	}
	if (value === Number.POSITIVE_INFINITY) {
		return "Infinity";
	}
	if (value === Number.NEGATIVE_INFINITY) {
		return "-Infinity";
	}
	if (Object.is(value, -0)) {
		return "-0";
	}
	return String(value);
}

function decodeNumber(value: string): number {
	switch (value) {
		case "NaN":
			return Number.NaN;
		case "Infinity":
			return Number.POSITIVE_INFINITY;
		case "-Infinity":
			return Number.NEGATIVE_INFINITY;
		case "-0":
			return -0;
		default:
			return Number(value);
	}
}

class OutboundEmailObservation {
	readonly message: EmailMessage | EmailMessageBuilder;

	constructor(message: EmailMessage | EmailMessageBuilder) {
		this.message = message;
	}
}

function objectType(value: object): string {
	const prototype = Object.getPrototypeOf(value) as {constructor?: unknown} | null;
	const constructor = prototype?.constructor;
	if (typeof constructor === "function" && constructor.name !== "") {
		return constructor.name;
	}
	return Object.prototype.toString.call(value).slice(8, -1);
}

function isDurableObjectId(value: object): value is DurableObjectId {
	return objectType(value) === "DurableObjectId" && typeof Reflect.get(value, "equals") === "function";
}

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

function encodeOutboundEmail(
	message: EmailMessage | EmailMessageBuilder,
	id: number,
	references: Map<object, number>,
	redactMachineTokenSecrets: boolean,
): EncodedObservedValue {
	if (!("subject" in message)) {
		return {
			kind: "email_message",
			id,
			from: redactMachineTokenSecrets ? redactMachineTokens(message.from) : message.from,
			to: redactMachineTokenSecrets ? redactMachineTokens(message.to) : message.to,
			content: {available: false, reason: "raw_mime_not_exposed_by_send_binding"},
		};
	}
	return {
		kind: "email_message_builder",
		id,
		value: [
			["attachments", encodeValue(message.attachments, references, redactMachineTokenSecrets)],
			["bcc", encodeValue(message.bcc, references, redactMachineTokenSecrets)],
			["cc", encodeValue(message.cc, references, redactMachineTokenSecrets)],
			["from", encodeValue(message.from, references, redactMachineTokenSecrets)],
			["headers", encodeValue(message.headers, references, redactMachineTokenSecrets)],
			["html", encodeValue(message.html, references, redactMachineTokenSecrets)],
			["replyTo", encodeValue(message.replyTo, references, redactMachineTokenSecrets)],
			["subject", encodeValue(message.subject, references, redactMachineTokenSecrets)],
			["text", encodeValue(message.text, references, redactMachineTokenSecrets)],
			["to", encodeValue(message.to, references, redactMachineTokenSecrets)],
		],
	};
}

function encodeValue(
	value: unknown,
	references: Map<object, number>,
	redactMachineTokenSecrets: boolean,
): EncodedObservedValue {
	if (value === null) {
		return {kind: "null"};
	}
	switch (typeof value) {
		case "undefined":
			return {kind: "undefined"};
		case "boolean":
			return {kind: "boolean", value};
		case "string":
			return {kind: "string", value: redactMachineTokenSecrets ? redactMachineTokens(value) : value};
		case "number":
			return {kind: "number", value: encodeNumber(value)};
		case "bigint":
			return {kind: "bigint", value: String(value)};
		case "function":
		case "symbol":
			throw new TypeError(`Cannot observe ${typeof value} values`);
		case "object":
			break;
	}

	const reference = references.get(value);
	if (reference !== undefined) {
		return {kind: "reference", id: reference};
	}
	const id = references.size;
	references.set(value, id);

	if (value instanceof OutboundEmailObservation) {
		return encodeOutboundEmail(value.message, id, references, redactMachineTokenSecrets);
	}
	if (value instanceof ArrayBuffer) {
		const bytes = new Uint8Array(value);
		return {
			kind: "array_buffer",
			id,
			value: bytesToBase64(redactMachineTokenSecrets ? redactMachineTokenBytes(bytes) : bytes),
		};
	}
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return {
			kind: "array_buffer_view",
			id,
			view: value.constructor.name,
			value: bytesToBase64(redactMachineTokenSecrets ? redactMachineTokenBytes(bytes) : bytes),
		};
	}
	if (value instanceof Date) {
		return {kind: "date", id, value: value.toISOString()};
	}
	if (value instanceof Error) {
		const properties = Object.keys(value)
			.filter((key) => key !== "cause")
			.sort()
			.map((key): [string, EncodedObservedValue] => [
				redactMachineTokenSecrets ? redactMachineTokens(key) : key,
				encodeValue(Reflect.get(value, key), references, redactMachineTokenSecrets),
			]);
		return {
			kind: "error",
			id,
			name: redactMachineTokenSecrets ? redactMachineTokens(value.name) : value.name,
			message: redactMachineTokenSecrets ? redactMachineTokens(value.message) : value.message,
			...(value.stack === undefined
				? {}
				: {stack: redactMachineTokenSecrets ? redactMachineTokens(value.stack) : value.stack}),
			cause: encodeValue(value.cause, references, redactMachineTokenSecrets),
			properties,
		};
	}
	if (Array.isArray(value)) {
		return {
			kind: "array",
			id,
			value: value.map((item) => encodeValue(item, references, redactMachineTokenSecrets)),
		};
	}
	if (value instanceof Map) {
		return {
			kind: "map",
			id,
			value: Array.from(value, ([key, item]) => [
				encodeValue(key, references, redactMachineTokenSecrets),
				encodeValue(item, references, redactMachineTokenSecrets),
			]),
		};
	}
	if (value instanceof Set) {
		return {
			kind: "set",
			id,
			value: Array.from(value, (item) => encodeValue(item, references, redactMachineTokenSecrets)),
		};
	}
	if (value instanceof Headers) {
		return {
			kind: "headers",
			id,
			value: Array.from(value.entries(), ([name, headerValue]) => [
				name,
				redactMachineTokenSecrets ? redactMachineTokens(headerValue) : headerValue,
			]),
		};
	}
	if (value instanceof URL) {
		return {kind: "url", id, value: redactMachineTokenSecrets ? redactMachineTokens(value.href) : value.href};
	}
	if (isDurableObjectId(value)) {
		return {kind: "durable_object_id", id, value: value.toString()};
	}
	if (!isPlainObject(value)) {
		return {kind: "unsupported", id, type: objectType(value), reason: "unsupported_platform_object"};
	}
	return {
		kind: "object",
		id,
		value: Object.keys(value)
			.sort()
			.map((key): [string, EncodedObservedValue] => [
				redactMachineTokenSecrets ? redactMachineTokens(key) : key,
				encodeValue(Reflect.get(value, key), references, redactMachineTokenSecrets),
			]),
	};
}

export function encodeObservedValue(value: unknown): EncodedObservedValue {
	return encodeValue(value, new Map(), false);
}

function decodeArrayBufferView(view: string, bytes: Uint8Array): ArrayBufferView {
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	switch (view) {
		case "DataView":
			return new DataView(buffer);
		case "Int8Array":
			return new Int8Array(buffer);
		case "Uint8Array":
			return new Uint8Array(buffer);
		case "Uint8ClampedArray":
			return new Uint8ClampedArray(buffer);
		case "Int16Array":
			return new Int16Array(buffer);
		case "Uint16Array":
			return new Uint16Array(buffer);
		case "Int32Array":
			return new Int32Array(buffer);
		case "Uint32Array":
			return new Uint32Array(buffer);
		case "Float32Array":
			return new Float32Array(buffer);
		case "Float64Array":
			return new Float64Array(buffer);
		case "BigInt64Array":
			return new BigInt64Array(buffer);
		case "BigUint64Array":
			return new BigUint64Array(buffer);
		default:
			throw new TypeError(`Unsupported observed ArrayBuffer view: ${view}`);
	}
}

function decodeValue(value: EncodedObservedValue, references: Map<number, object>): unknown {
	switch (value.kind) {
		case "null":
			return null;
		case "undefined":
			return undefined;
		case "boolean":
		case "string":
			return value.value;
		case "number":
			return decodeNumber(value.value);
		case "bigint":
			return BigInt(value.value);
		case "reference": {
			const reference = references.get(value.id);
			if (reference === undefined) {
				throw new TypeError(`Unknown observed reference: ${value.id}`);
			}
			return reference;
		}
		case "array": {
			const decoded: unknown[] = [];
			references.set(value.id, decoded);
			decoded.push(...value.value.map((item) => decodeValue(item, references)));
			return decoded;
		}
		case "object": {
			const decoded: Record<string, unknown> = {};
			references.set(value.id, decoded);
			for (const [key, item] of value.value) {
				decoded[key] = decodeValue(item, references);
			}
			return decoded;
		}
		case "map": {
			const decoded = new Map<unknown, unknown>();
			references.set(value.id, decoded);
			for (const [key, item] of value.value) {
				decoded.set(decodeValue(key, references), decodeValue(item, references));
			}
			return decoded;
		}
		case "set": {
			const decoded = new Set<unknown>();
			references.set(value.id, decoded);
			for (const item of value.value) {
				decoded.add(decodeValue(item, references));
			}
			return decoded;
		}
		case "date": {
			const decoded = new Date(value.value);
			references.set(value.id, decoded);
			return decoded;
		}
		case "error": {
			const decoded = value.name === "TypeError" ? new TypeError(value.message) : new Error(value.message);
			references.set(value.id, decoded);
			if (decoded.name !== value.name) {
				decoded.name = value.name;
			}
			if (value.stack !== undefined) {
				decoded.stack = value.stack;
			}
			decoded.cause = decodeValue(value.cause, references);
			for (const [key, item] of value.properties) {
				Reflect.set(decoded, key, decodeValue(item, references));
			}
			return decoded;
		}
		case "array_buffer": {
			const bytes = base64ToBytes(value.value);
			const decoded = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			references.set(value.id, decoded);
			return decoded;
		}
		case "array_buffer_view": {
			const decoded = decodeArrayBufferView(value.view, base64ToBytes(value.value));
			references.set(value.id, decoded);
			return decoded;
		}
		case "durable_object_id": {
			const decoded = {kind: value.kind, value: value.value};
			references.set(value.id, decoded);
			return decoded;
		}
		case "headers": {
			const decoded = {kind: value.kind, entries: value.value};
			references.set(value.id, decoded);
			return decoded;
		}
		case "url": {
			const decoded = {kind: value.kind, href: value.value};
			references.set(value.id, decoded);
			return decoded;
		}
		case "email_message": {
			const decoded = {
				kind: value.kind,
				envelope: {from: value.from, to: value.to},
				content: value.content,
			};
			references.set(value.id, decoded);
			return decoded;
		}
		case "email_message_builder": {
			const decoded: {kind: "email_message_builder"; fields: Record<string, unknown>} = {
				kind: value.kind,
				fields: {},
			};
			references.set(value.id, decoded);
			for (const [key, item] of value.value) {
				decoded.fields[key] = decodeValue(item, references);
			}
			return decoded;
		}
		case "unsupported": {
			const decoded = {kind: value.kind, type: value.type, reason: value.reason};
			references.set(value.id, decoded);
			return decoded;
		}
	}
	throw new TypeError("Unsupported encoded observed value");
}

export function decodeObservedValue(value: StoredObservedValue): unknown {
	if (value.kind === "truncated") {
		return {
			kind: value.kind,
			originalKind: value.original_kind,
			encodedPrefix: base64ToBytes(value.value).buffer,
		};
	}
	if (value.kind === "dropped") {
		return {kind: value.kind, originalKind: value.original_kind};
	}
	return decodeValue(value, new Map());
}

export function emitObservation(
	context: ObservationContext,
	operation: string,
	phase: string,
	data: unknown,
	severity: ObservationSeverity = "log",
): string[] {
	return emitEncodedObservation(context, operation, phase, encodeObservedValue(redactObservedValue(data)), severity);
}

function emitDebugObservation(
	context: ObservationContext,
	operation: string,
	phase: string,
	data: unknown,
	severity: ObservationSeverity = "log",
): string[] {
	return emitEncodedObservation(context, operation, phase, encodeValue(data, new Map(), true), severity);
}

function emitEncodedObservation(
	context: ObservationContext,
	operation: string,
	phase: string,
	data: EncodedObservedValue,
	severity: ObservationSeverity,
): string[] {
	const originalDataBytes = new TextEncoder().encode(JSON.stringify(data));
	const baseEvent = {
		schema: OBSERVATION_SCHEMA,
		event_id: crypto.randomUUID(),
		correlation_id: context.correlationId,
		component: context.component,
		...(context.objectId === undefined ? {} : {object_id: context.objectId}),
		operation,
		phase,
		timestamp: Date.now(),
	} as const;
	const availableInvocationBytes = OBSERVATION_INVOCATION_BYTES - context.outputBudget.emittedBytes;
	const priorityEvent = severity === "error" || phase === "failure" || operation === "http.response";
	const availableDataBytes = priorityEvent
		? availableInvocationBytes
		: availableInvocationBytes - OBSERVATION_PRIORITY_RESERVE_BYTES - OBSERVATION_DROP_RESERVE_BYTES;
	const availableBytes = Math.min(OBSERVATION_LINE_BYTES, availableDataBytes);
	const availableDropBytes = Math.min(
		OBSERVATION_LINE_BYTES,
		priorityEvent ? availableInvocationBytes : availableInvocationBytes - OBSERVATION_PRIORITY_RESERVE_BYTES,
	);

	const completeEvent: ObservationEvent = {
		...baseEvent,
		metadata: {
			original_encoded_byte_length: originalDataBytes.length,
			retained_encoded_byte_length: originalDataBytes.length,
			data_truncated: false,
			event_dropped: false,
		},
		data,
	};
	const completeLine = JSON.stringify(completeEvent);
	if (availableBytes > 0 && encodedByteLength(completeLine) <= availableBytes) {
		return emitObservationLine(context, severity, completeLine);
	}

	let lowerBound = 1;
	let upperBound = originalDataBytes.length;
	let truncatedLine: string | undefined;
	while (availableBytes > 0 && lowerBound <= upperBound) {
		const retainedEncodedByteLength = Math.floor((lowerBound + upperBound) / 2);
		const candidate = JSON.stringify({
			...baseEvent,
			metadata: {
				original_encoded_byte_length: originalDataBytes.length,
				retained_encoded_byte_length: retainedEncodedByteLength,
				data_truncated: true,
				event_dropped: false,
			},
			data: {
				kind: "truncated",
				original_kind: data.kind,
				encoding: "base64",
				value: bytesToBase64(originalDataBytes.subarray(0, retainedEncodedByteLength)),
			} satisfies TruncatedObservedValue,
		} satisfies ObservationEvent);
		if (encodedByteLength(candidate) <= availableBytes) {
			truncatedLine = candidate;
			lowerBound = retainedEncodedByteLength + 1;
		} else {
			upperBound = retainedEncodedByteLength - 1;
		}
	}
	if (truncatedLine !== undefined) {
		return emitObservationLine(context, severity, truncatedLine);
	}

	const droppedLine = JSON.stringify({
		...baseEvent,
		metadata: {
			original_encoded_byte_length: originalDataBytes.length,
			retained_encoded_byte_length: 0,
			data_truncated: false,
			event_dropped: true,
		},
		data: {kind: "dropped", original_kind: data.kind},
	} satisfies ObservationEvent);
	return encodedByteLength(droppedLine) <= availableDropBytes
		? emitObservationLine(context, severity, droppedLine)
		: [];
}

function encodedByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function emitObservationLine(context: ObservationContext, severity: ObservationSeverity, line: string): string[] {
	const sink = context.sink ?? defaultObservationSink;
	context.outputBudget.emittedBytes += encodedByteLength(line) + OBSERVATION_LINE_SEPARATOR_BYTES;
	sink(severity, line);
	return [line];
}

export function reconstructObservation(lines: string[]): ObservationEvent {
	const [line] = lines;
	if (line === undefined || lines.length !== 1) {
		throw new TypeError("An observed event must contain exactly one structured log line");
	}
	return JSON.parse(line) as ObservationEvent;
}

export function decodedObservationData(event: ObservationEvent): unknown {
	return decodeObservedValue(event.data);
}

interface ObservedD1StatementDescription {
	query: string;
	bindings: unknown[];
}

class ObservedD1PreparedStatement implements D1PreparedStatement {
	readonly rawStatement: D1PreparedStatement;
	readonly description: ObservedD1StatementDescription;
	private readonly context: ObservationContext;

	constructor(
		rawStatement: D1PreparedStatement,
		context: ObservationContext,
		description: ObservedD1StatementDescription,
	) {
		this.rawStatement = rawStatement;
		this.context = context;
		this.description = description;
	}

	bind(...values: unknown[]): D1PreparedStatement {
		emitObservation(this.context, "d1.statement.bind", "input", {
			query: this.description.query,
			bindings: values,
		});
		try {
			const statement = this.rawStatement.bind(...values);
			emitObservation(this.context, "d1.statement.bind", "output", {
				query: this.description.query,
				bindings: values,
			});
			return new ObservedD1PreparedStatement(statement, this.context, {
				query: this.description.query,
				bindings: values,
			});
		} catch (error) {
			emitObservation(this.context, "d1.statement.bind", "failure", error, "error");
			throw error;
		}
	}

	first<T = unknown>(columnName: string): Promise<T | null>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
		return this.execute("first", columnName === undefined ? [] : [columnName], async () =>
			columnName === undefined ? this.rawStatement.first<T>() : this.rawStatement.first<T>(columnName),
		);
	}

	async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.execute("run", [], async () => this.rawStatement.run<T>());
	}

	async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.execute("all", [], async () => this.rawStatement.all<T>());
	}

	raw<T = unknown[]>(options: {columnNames: true}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: {columnNames?: false}): Promise<T[]>;
	async raw<T = unknown[]>(options?: {columnNames?: boolean}): Promise<T[] | [string[], ...T[]]> {
		if (options?.columnNames === true) {
			return this.execute("raw", [options], async () => this.rawStatement.raw<T>({columnNames: true}));
		}
		return this.execute("raw", options === undefined ? [] : [options], async () => this.rawStatement.raw<T>());
	}

	private async execute<Result>(
		method: string,
		arguments_: unknown[],
		execute: () => Promise<Result>,
	): Promise<Result> {
		const operation = `d1.statement.${method}`;
		emitObservation(this.context, operation, "input", {statement: this.description, arguments: arguments_});
		try {
			const result = await execute();
			emitObservation(this.context, operation, "output", {
				statement: this.description,
				arguments: arguments_,
				result,
			});
			return result;
		} catch (error) {
			emitObservation(
				this.context,
				operation,
				"failure",
				{
					statement: this.description,
					arguments: arguments_,
					error,
				},
				"error",
			);
			throw error;
		}
	}
}

function unwrapD1Statements(statements: D1PreparedStatement[]): {
	rawStatements: D1PreparedStatement[];
	descriptions: ObservedD1StatementDescription[];
} {
	const rawStatements: D1PreparedStatement[] = [];
	const descriptions: ObservedD1StatementDescription[] = [];
	for (const statement of statements) {
		if (!(statement instanceof ObservedD1PreparedStatement)) {
			throw new TypeError("Observed D1 batches require statements prepared by the observed binding");
		}
		rawStatements.push(statement.rawStatement);
		descriptions.push(statement.description);
	}
	return {rawStatements, descriptions};
}

class ObservedD1DatabaseSession implements D1DatabaseSession {
	private readonly rawSession: D1DatabaseSession;
	private readonly context: ObservationContext;

	constructor(rawSession: D1DatabaseSession, context: ObservationContext) {
		this.rawSession = rawSession;
		this.context = context;
	}

	prepare(query: string): D1PreparedStatement {
		emitObservation(this.context, "d1.session.prepare", "input", {query});
		try {
			const statement = new ObservedD1PreparedStatement(this.rawSession.prepare(query), this.context, {
				query,
				bindings: [],
			});
			emitObservation(this.context, "d1.session.prepare", "output", {query});
			return statement;
		} catch (error) {
			emitObservation(this.context, "d1.session.prepare", "failure", {query, error}, "error");
			throw error;
		}
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		const {rawStatements, descriptions} = unwrapD1Statements(statements);
		emitObservation(this.context, "d1.session.batch", "input", {statements: descriptions});
		try {
			const result = await this.rawSession.batch<T>(rawStatements);
			emitObservation(this.context, "d1.session.batch", "output", {statements: descriptions, result});
			return result;
		} catch (error) {
			emitObservation(this.context, "d1.session.batch", "failure", {statements: descriptions, error}, "error");
			throw error;
		}
	}

	getBookmark(): D1SessionBookmark | null {
		emitObservation(this.context, "d1.session.get_bookmark", "input", null);
		try {
			const result = this.rawSession.getBookmark();
			emitObservation(this.context, "d1.session.get_bookmark", "output", result);
			return result;
		} catch (error) {
			emitObservation(this.context, "d1.session.get_bookmark", "failure", error, "error");
			throw error;
		}
	}
}

class ObservedD1Database implements D1Database {
	private readonly rawDatabase: D1Database;
	private readonly context: ObservationContext;

	constructor(rawDatabase: D1Database, context: ObservationContext) {
		this.rawDatabase = rawDatabase;
		this.context = context;
	}

	prepare(query: string): D1PreparedStatement {
		emitObservation(this.context, "d1.prepare", "input", {query});
		try {
			const statement = new ObservedD1PreparedStatement(this.rawDatabase.prepare(query), this.context, {
				query,
				bindings: [],
			});
			emitObservation(this.context, "d1.prepare", "output", {query});
			return statement;
		} catch (error) {
			emitObservation(this.context, "d1.prepare", "failure", {query, error}, "error");
			throw error;
		}
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		const {rawStatements, descriptions} = unwrapD1Statements(statements);
		emitObservation(this.context, "d1.batch", "input", {statements: descriptions});
		try {
			const result = await this.rawDatabase.batch<T>(rawStatements);
			emitObservation(this.context, "d1.batch", "output", {statements: descriptions, result});
			return result;
		} catch (error) {
			emitObservation(this.context, "d1.batch", "failure", {statements: descriptions, error}, "error");
			throw error;
		}
	}

	async exec(query: string): Promise<D1ExecResult> {
		emitObservation(this.context, "d1.exec", "input", {query});
		try {
			const result = await this.rawDatabase.exec(query);
			emitObservation(this.context, "d1.exec", "output", {query, result});
			return result;
		} catch (error) {
			emitObservation(this.context, "d1.exec", "failure", {query, error}, "error");
			throw error;
		}
	}

	withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
		emitObservation(this.context, "d1.with_session", "input", {constraintOrBookmark});
		try {
			const session = new ObservedD1DatabaseSession(
				this.rawDatabase.withSession(constraintOrBookmark),
				this.context,
			);
			emitObservation(this.context, "d1.with_session", "output", {constraintOrBookmark});
			return session;
		} catch (error) {
			emitObservation(this.context, "d1.with_session", "failure", {constraintOrBookmark, error}, "error");
			throw error;
		}
	}

	async dump(): Promise<ArrayBuffer> {
		emitObservation(this.context, "d1.dump", "input", null);
		try {
			const result = await this.rawDatabase.dump();
			emitObservation(this.context, "d1.dump", "output", result);
			return result;
		} catch (error) {
			emitObservation(this.context, "d1.dump", "failure", error, "error");
			throw error;
		}
	}
}

export function observeD1Database(database: D1Database, context: ObservationContext): D1Database {
	return new ObservedD1Database(database, context);
}

interface CapturedBody {
	body: ArrayBuffer;
	bodyTruncated: boolean;
}

function observedBody(
	body: ReadableStream<Uint8Array>,
	complete: (captured: CapturedBody) => void,
	fail: (error: unknown) => void,
): ReadableStream<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let capturedBytes = 0;
	let bodyTruncated = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				reader ??= body.getReader();
				let result: ReadableStreamReadResult<Uint8Array>;
				try {
					result = await reader.read();
				} catch (error) {
					fail(error);
					controller.error(error);
					return;
				}
				if (result.done) {
					const captured = new Uint8Array(capturedBytes);
					let offset = 0;
					for (const chunk of chunks) {
						captured.set(chunk, offset);
						offset += chunk.byteLength;
					}
					complete({body: captured.buffer, bodyTruncated});
					controller.close();
					return;
				}

				const remainingBytes = OBSERVED_BODY_BYTES - capturedBytes;
				if (remainingBytes > 0) {
					const capturedChunk = result.value.slice(0, remainingBytes);
					if (capturedChunk.byteLength > 0) {
						chunks.push(capturedChunk);
					}
					capturedBytes += capturedChunk.byteLength;
				}
				bodyTruncated ||= result.value.byteLength > remainingBytes;
				controller.enqueue(result.value);
			},
			async cancel(reason) {
				try {
					reader ??= body.getReader();
					await reader.cancel(reason);
				} catch (error) {
					fail(error);
					throw error;
				}
			},
		},
		{highWaterMark: 0},
	);
}

function emitHttpCaptureFailure(context: ObservationContext, operation: string, error: unknown): void {
	try {
		emitDebugObservation(context, `${operation}.capture`, "failure", error, "error");
	} catch {
		// Observation failures must not affect the HTTP exchange.
	}
}

function emitHttpObservation(context: ObservationContext, operation: string, data: unknown): void {
	try {
		emitDebugObservation(context, operation, operation === "http.request" ? "input" : "output", data);
	} catch (error) {
		emitHttpCaptureFailure(context, operation, error);
	}
}

function requestObservation(request: Request, context: ObservationContext): Request {
	const observation = {
		method: request.method,
		url: request.url,
		headers: Array.from(request.headers.entries()),
	};
	if (request.body === null) {
		emitHttpObservation(context, "http.request", {...observation, body: null, bodyTruncated: false});
		return request;
	}
	try {
		const body = observedBody(
			request.body,
			(captured) => {
				emitHttpObservation(context, "http.request", {...observation, ...captured});
			},
			(error) => {
				emitHttpCaptureFailure(context, "http.request", error);
			},
		);
		return new Request(request, {body});
	} catch (error) {
		emitHttpCaptureFailure(context, "http.request", error);
		return request;
	}
}

function responseObservation(response: Response, context: ObservationContext): Response {
	const observation = {
		status: response.status,
		statusText: response.statusText,
		headers: Array.from(response.headers.entries()),
		webSocket: response.webSocket !== null,
	};
	if (response.body === null || response.webSocket !== null) {
		emitHttpObservation(context, "http.response", {...observation, body: null, bodyTruncated: false});
		return response;
	}
	try {
		const body = observedBody(
			response.body,
			(captured) => {
				emitHttpObservation(context, "http.response", {...observation, ...captured});
			},
			(error) => {
				emitHttpCaptureFailure(context, "http.response", error);
			},
		);
		return new Response(body, response);
	} catch (error) {
		emitHttpCaptureFailure(context, "http.response", error);
		return response;
	}
}

export async function observeHttpExchange(
	context: ObservationContext,
	request: Request,
	handle: (request: Request) => Promise<Response>,
): Promise<Response> {
	const observedRequest = requestObservation(request, context);
	try {
		return responseObservation(await handle(observedRequest), context);
	} catch (error) {
		emitObservation(context, "http.exchange", "failure", error, "error");
		throw error;
	}
}

function cursorMetadata(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): unknown {
	return {
		columnNames: cursor.columnNames,
		rowsRead: cursor.rowsRead,
		rowsWritten: cursor.rowsWritten,
	};
}

function observeIterator<Value>(
	iterator: IterableIterator<Value>,
	context: ObservationContext,
	operation: string,
	cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
): IterableIterator<Value> {
	let observed: IterableIterator<Value>;
	observed = new Proxy(iterator, {
		get(target, property) {
			if (property === Symbol.iterator) {
				return (): IterableIterator<Value> => observed;
			}
			const member = Reflect.get(target, property, target);
			if (typeof member !== "function") {
				return member;
			}
			return (...arguments_: unknown[]): unknown => {
				try {
					const result = Reflect.apply(member, target, arguments_);
					emitObservation(context, `${operation}.${String(property)}`, "output", {
						result,
						metadata: cursorMetadata(cursor),
					});
					return result;
				} catch (error) {
					emitObservation(context, `${operation}.${String(property)}`, "failure", error, "error");
					throw error;
				}
			};
		},
	});
	return observed;
}

function observeSqlCursor<Row extends Record<string, SqlStorageValue>>(
	cursor: SqlStorageCursor<Row>,
	context: ObservationContext,
	query: string,
	bindings: unknown[],
): SqlStorageCursor<Row> {
	return new Proxy(cursor, {
		get(target, property) {
			if (property === "next") {
				return () => {
					try {
						const result = target.next();
						emitObservation(context, "do.sql.cursor.next", "output", {
							query,
							bindings,
							result,
							metadata: cursorMetadata(target),
						});
						return result;
					} catch (error) {
						emitObservation(context, "do.sql.cursor.next", "failure", {query, bindings, error}, "error");
						throw error;
					}
				};
			}
			if (property === "toArray" || property === "one") {
				return (): unknown => {
					const operation = `do.sql.cursor.${String(property)}`;
					try {
						const result = property === "toArray" ? target.toArray() : target.one();
						emitObservation(context, operation, "output", {
							query,
							bindings,
							result,
							metadata: cursorMetadata(target),
						});
						return result;
					} catch (error) {
						emitObservation(context, operation, "failure", {query, bindings, error}, "error");
						throw error;
					}
				};
			}
			if (property === "raw") {
				return <Value extends SqlStorageValue[]>(): IterableIterator<Value> =>
					observeIterator(target.raw<Value>(), context, "do.sql.cursor.raw.next", target);
			}
			if (property === Symbol.iterator) {
				return (): IterableIterator<Row> =>
					observeIterator(target[Symbol.iterator](), context, "do.sql.cursor.iterator.next", target);
			}
			if (property === "columnNames" || property === "rowsRead" || property === "rowsWritten") {
				try {
					const result = Reflect.get(target, property, target);
					emitObservation(context, `do.sql.cursor.${String(property)}`, "output", {query, bindings, result});
					return result;
				} catch (error) {
					emitObservation(
						context,
						`do.sql.cursor.${String(property)}`,
						"failure",
						{query, bindings, error},
						"error",
					);
					throw error;
				}
			}
			const result = Reflect.get(target, property, target);
			return typeof result === "function" ? result.bind(target) : result;
		},
	});
}

function observeSqlStorage(storage: SqlStorage, context: ObservationContext): SqlStorage {
	return new Proxy(storage, {
		get(target, property) {
			if (property === "exec") {
				return <Row extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
					emitObservation(context, "do.sql.exec", "input", {query, bindings});
					try {
						const cursor = target.exec<Row>(query, ...bindings);
						emitObservation(context, "do.sql.exec", "output", {query, bindings, cursor: "created"});
						return observeSqlCursor(cursor, context, query, bindings);
					} catch (error) {
						emitObservation(context, "do.sql.exec", "failure", {query, bindings, error}, "error");
						throw error;
					}
				};
			}
			if (property === "databaseSize") {
				try {
					const result = target.databaseSize;
					emitObservation(context, "do.sql.database_size", "output", result);
					return result;
				} catch (error) {
					emitObservation(context, "do.sql.database_size", "failure", error, "error");
					throw error;
				}
			}
			const result = Reflect.get(target, property, target);
			return typeof result === "function" ? result.bind(target) : result;
		},
	});
}

function observeSynchronousKvStorage(storage: SyncKvStorage, context: ObservationContext): SyncKvStorage {
	return new Proxy(storage, {
		get(target, property) {
			const member = Reflect.get(target, property, target);
			if (typeof member !== "function") {
				return member;
			}
			return (...arguments_: unknown[]): unknown => {
				const operation = `do.storage.kv.${String(property)}`;
				emitObservation(context, operation, "input", {arguments: arguments_});
				try {
					const result = Reflect.apply(member, target, arguments_);
					const observedResult = property === "list" ? Array.from(result as Iterable<unknown>) : result;
					emitObservation(context, operation, "output", observedResult);
					return property === "list" ? observedResult : result;
				} catch (error) {
					emitObservation(context, operation, "failure", {arguments: arguments_, error}, "error");
					throw error;
				}
			};
		},
	});
}

function observeDurableObjectTransaction(
	transaction: DurableObjectTransaction,
	context: ObservationContext,
): DurableObjectTransaction {
	return new Proxy(transaction, {
		get(target, property) {
			const member = Reflect.get(target, property, target);
			if (typeof member !== "function") {
				return member;
			}
			return (...arguments_: unknown[]): unknown =>
				observePlatformOperation(context, `do.storage.transaction.${String(property)}`, arguments_, () =>
					Reflect.apply(member, target, arguments_),
				);
		},
	});
}

function observePlatformOperation(
	context: ObservationContext,
	operation: string,
	arguments_: unknown[],
	execute: () => unknown,
): unknown {
	return observePlatformOperationWithEmitter(context, operation, arguments_, execute, emitObservation);
}

function observeDebugPlatformOperation(
	context: ObservationContext,
	operation: string,
	arguments_: unknown[],
	execute: () => unknown,
): unknown {
	return observePlatformOperationWithEmitter(context, operation, arguments_, execute, emitDebugObservation);
}

function observePlatformOperationWithEmitter(
	context: ObservationContext,
	operation: string,
	arguments_: unknown[],
	execute: () => unknown,
	emit: typeof emitObservation,
): unknown {
	emit(context, operation, "input", {arguments: arguments_});
	try {
		const result = execute();
		if (isPromiseLike(result)) {
			return Promise.resolve(result).then(
				(value) => {
					emit(context, operation, "output", value);
					return value;
				},
				(error: unknown) => {
					emit(context, operation, "failure", {arguments: arguments_, error}, "error");
					throw error;
				},
			);
		}
		emit(context, operation, "output", result);
		return result;
	} catch (error) {
		emit(context, operation, "failure", {arguments: arguments_, error}, "error");
		throw error;
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function") ||
		(typeof value === "function" && typeof Reflect.get(value, "then") === "function")
	);
}

export function observeDurableObjectStorage(
	storage: DurableObjectStorage,
	context: ObservationContext,
): DurableObjectStorage {
	const sql = observeSqlStorage(storage.sql, context);
	const keyValue = observeSynchronousKvStorage(storage.kv, context);
	return new Proxy(storage, {
		get(target, property) {
			if (property === "sql") {
				return sql;
			}
			if (property === "kv") {
				return keyValue;
			}
			if (property === "transaction") {
				return async <Result>(
					closure: (transaction: DurableObjectTransaction) => Promise<Result>,
				): Promise<Result> =>
					observePlatformOperation(context, "do.storage.transaction", [], async () =>
						target.transaction(async (transaction) =>
							closure(observeDurableObjectTransaction(transaction, context)),
						),
					) as Promise<Result>;
			}
			if (property === "transactionSync") {
				return <Result>(closure: () => Result): Result =>
					observePlatformOperation(context, "do.storage.transaction_sync", [], () =>
						target.transactionSync(closure),
					) as Result;
			}
			const member = Reflect.get(target, property, target);
			if (typeof member !== "function") {
				return member;
			}
			return (...arguments_: unknown[]): unknown =>
				observePlatformOperation(context, `do.storage.${String(property)}`, arguments_, () =>
					Reflect.apply(member, target, arguments_),
				);
		},
	});
}

export function observeDurableObjectState<Properties>(
	state: DurableObjectState<Properties>,
	context: ObservationContext,
): DurableObjectState<Properties> {
	const storage = observeDurableObjectStorage(state.storage, context);
	return new Proxy(state, {
		get(target, property) {
			if (property === "storage") {
				return storage;
			}
			const member = Reflect.get(target, property, target);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
}

function observeDurableObjectStub(stub: DurableObjectStub, context: ObservationContext): DurableObjectStub {
	return new Proxy(stub, {
		get(target, property) {
			const member = Reflect.get(target, property, target);
			if (typeof member !== "function") {
				return member;
			}
			if (property === "fetch") {
				return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
					const request = new Request(input, init);
					return observeHttpExchange(context, request, async (request) => target.fetch(request));
				};
			}
			return (...arguments_: unknown[]): unknown =>
				observePlatformOperation(context, `do.rpc.${String(property)}`, arguments_, () =>
					Reflect.apply(member, target, arguments_),
				);
		},
	});
}

function observeDurableObjectNamespace(
	namespace: DurableObjectNamespace,
	context: ObservationContext,
): DurableObjectNamespace {
	return new Proxy(namespace, {
		get(target, property) {
			const member = Reflect.get(target, property, target);
			if (typeof member !== "function") {
				return member;
			}
			if (property === "get" || property === "getByName") {
				return (...arguments_: unknown[]): DurableObjectStub => {
					const operation = `do.namespace.${String(property)}`;
					emitDebugObservation(context, operation, "input", {arguments: arguments_});
					try {
						const stub = Reflect.apply(member, target, arguments_) as DurableObjectStub;
						emitDebugObservation(context, operation, "output", {
							id: stub.id.toString(),
							name: stub.name,
						});
						return observeDurableObjectStub(stub, {
							...context,
							objectId: stub.id.toString(),
						});
					} catch (error) {
						emitDebugObservation(context, operation, "failure", {arguments: arguments_, error}, "error");
						throw error;
					}
				};
			}
			return (...arguments_: unknown[]): unknown =>
				observeDebugPlatformOperation(context, `do.namespace.${String(property)}`, arguments_, () =>
					Reflect.apply(member, target, arguments_),
				);
		},
	});
}

function observeEmailBinding(email: SendEmail, context: ObservationContext): SendEmail {
	return new Proxy(email, {
		get(target, property) {
			const member = Reflect.get(target, property, target);
			if (property !== "send" || typeof member !== "function") {
				return typeof member === "function" ? member.bind(target) : member;
			}
			return async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> =>
				observeDebugPlatformOperation(context, "email.send", [new OutboundEmailObservation(message)], () =>
					Reflect.apply(member, target, [message]),
				) as Promise<EmailSendResult>;
		},
	});
}

export function observeEnvironment<Environment extends object>(
	environment: Environment,
	context: ObservationContext,
): Environment {
	const database = observeD1Database(Reflect.get(environment, "DB") as D1Database, context);
	const namespace = observeDurableObjectNamespace(
		Reflect.get(environment, "USER_DO") as DurableObjectNamespace,
		context,
	);
	const rawEmail = Reflect.get(environment, "EMAIL") as SendEmail | undefined;
	const email = rawEmail === undefined ? undefined : observeEmailBinding(rawEmail, context);
	return new Proxy(environment, {
		get(target, property) {
			switch (property) {
				case "DB":
					return database;
				case "USER_DO":
					return namespace;
				case "EMAIL":
					return email;
				default:
					return Reflect.get(target, property, target);
			}
		},
	});
}

export function observeWebSocketFrame(
	context: ObservationContext,
	direction: "inbound" | "outbound",
	message: unknown,
): void {
	emitObservation(context, "websocket.frame", direction, message);
}
