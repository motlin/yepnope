import {McpServer, WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/server";
import {describe, expect, it} from "vitest";

describe("MCP v2 Cloudflare runtime compatibility", () => {
	it("serves Streamable HTTP through Web Standard Request and Response", async () => {
		const server = new McpServer({name: "workerd-oauth-proof", version: "1.0.0"});
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
			sessionIdGenerator: () => "workerd-proof-session",
		});
		await server.connect(transport);
		const response = await transport.handleRequest(
			new Request("https://proof.example/mcp", {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					id: 1,
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						capabilities: {},
						clientInfo: {name: "workerd-proof-client", version: "1.0.0"},
						protocolVersion: "2025-11-25",
					},
				}),
			}),
		);

		expect({
			body: await response.json(),
			sessionId: response.headers.get("mcp-session-id"),
			status: response.status,
		}).toStrictEqual({
			body: {
				id: 1,
				jsonrpc: "2.0",
				result: {
					capabilities: {},
					protocolVersion: "2025-11-25",
					serverInfo: {name: "workerd-oauth-proof", version: "1.0.0"},
				},
			},
			sessionId: "workerd-proof-session",
			status: 200,
		});
		await server.close();
	});
});
