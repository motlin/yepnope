import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {CallToolResultSchema} from "@modelcontextprotocol/sdk/types.js";
import {resolvedFrame} from "../../worker/protocol";
import {TOOL_DESCRIPTION, TOOL_NAME} from "../tool";
import {createShimServer} from "../server";
import {startMockBackend, type MockBackend} from "./mock-backend";

describe("shim MCP server", () => {
	let backend: MockBackend | undefined;
	let directory: string;
	let telemetryPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "yepnope-server-"));
		telemetryPath = join(directory, "telemetry.json");
	});

	afterEach(async () => {
		await backend?.close();
		backend = undefined;
		await rm(directory, {recursive: true, force: true});
	});

	async function connect(activeBackend: MockBackend): Promise<Client> {
		const server = createShimServer({
			baseUrl: activeBackend.baseUrl,
			token: "ynp_test",
			telemetryPath,
			heartbeatMilliseconds: 10,
			progressMilliseconds: 10,
			reconnectDelayMilliseconds: 10,
			deriveContext: async () => Promise.resolve({repo: null, branch: null, worktree: null, directory: "/w"}),
		});
		const client = new Client({name: "test-client", version: "0.0.0"});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		return client;
	}

	it("lists the ask_yep_nope tool with the verbatim description", async () => {
		backend = await startMockBackend();
		const client = await connect(backend);
		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
		expect(listed.tools[0]?.description).toBe(TOOL_DESCRIPTION);
	});

	it("returns answers, sends progress notifications, and appends coaching when the yep rate is high", async () => {
		await writeFile(telemetryPath, JSON.stringify({dispositions: Array(30).fill("yep")}));
		backend = await startMockBackend({
			createBody: {batch_id: "bat_1", question_ids: ["bat_1:0"]},
			onConnection(socket) {
				setTimeout(() => {
					socket.send(resolvedFrame("bat_1", {"bat_1:0": "yep"}));
				}, 50);
			},
		});
		const client = await connect(backend);
		let progressCount = 0;
		const result = await client.callTool(
			{
				name: TOOL_NAME,
				arguments: {project: "p", questions: [{title: "Ship it?", body: "context"}]},
			},
			CallToolResultSchema,
			{onprogress: () => (progressCount += 1)},
		);
		expect(result.isError ?? false).toBe(false);
		const text = (result.content as Array<{type: string; text: string}>)[0]?.text;
		expect(text).toBe(
			"Ship it? -> YEP\n\n" +
				"The user has answered yes to 100% of your last 31 questions. Ask less: act on your own " +
				"judgment unless a wrong guess would be expensive or irreversible.",
		);
		expect(progressCount).toBeGreaterThan(0);
	});

	it("returns a teaching tool error without touching the network when a title is too long", async () => {
		backend = await startMockBackend();
		const client = await connect(backend);
		const result = await client.callTool({
			name: TOOL_NAME,
			arguments: {project: "p", questions: [{title: "x".repeat(101), body: "b"}]},
		});
		expect(result.isError).toBe(true);
		expect(backend.batchBodies).toEqual([]);
	});

	it("surfaces the AFK-off 409 as a tool error verbatim", async () => {
		const message =
			"The user is at their keyboard, so questions are not being routed to their phone. " +
			"Use the AskUserQuestion tool instead of ask_yep_nope for this question.";
		backend = await startMockBackend({createStatus: 409, createBody: {error: "afk_off", message}});
		const client = await connect(backend);
		const result = await client.callTool({
			name: TOOL_NAME,
			arguments: {project: "p", questions: [{title: "Ship it?", body: "context"}]},
		});
		expect(result.isError).toBe(true);
		expect((result.content as Array<{type: string; text: string}>)[0]?.text).toBe(message);
	});

	it("rejects malformed arguments as a tool error", async () => {
		backend = await startMockBackend();
		const client = await connect(backend);
		const result = await client.callTool({name: TOOL_NAME, arguments: {project: "p", questions: []}});
		expect(result.isError).toBe(true);
		expect(backend.batchBodies).toEqual([]);
	});
});
