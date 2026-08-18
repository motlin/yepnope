import {createServer, type Server} from "node:http";
import {text} from "node:stream/consumers";
import {WebSocketServer, type WebSocket} from "ws";

const MOCK_MACHINE_TOKEN = `ynp_live_${"A".repeat(43)}`;

function requireAfk(body: unknown): boolean {
	if (typeof body !== "object" || body === null || !("afk" in body) || typeof body.afk !== "boolean") {
		throw new Error("mock backend received an invalid AFK request body");
	}
	return body.afk;
}

// 🧪 A tiny stand-in for the Worker API and its per-batch WebSocket stream.
export interface MockBackend {
	baseUrl: string;
	batchBodies: unknown[];
	claimBodies: unknown[];
	afkRequests: Array<{
		method: string | undefined;
		url: string | undefined;
		authorization: string | undefined;
		contentType: string | undefined;
		body: unknown;
	}>;
	authorizationHeaders: Array<string | undefined>;
	heartbeats: string[];
	connections: WebSocket[];
	close(): Promise<void>;
}

export interface MockBackendOptions {
	createStatus?: number;
	createBody?: unknown;
	claimStatus?: number;
	claimBody?: unknown;
	afk?: boolean;
	afkGetStatus?: number;
	afkPutStatus?: number;
	afkPutBody?: unknown;
	onConnection?: (socket: WebSocket, backend: MockBackend) => void;
}

export async function startMockBackend(options: MockBackendOptions = {}): Promise<MockBackend> {
	const server: Server = createServer();
	const websocketServer = new WebSocketServer({noServer: true});
	const backend: MockBackend = {
		baseUrl: "",
		batchBodies: [],
		claimBodies: [],
		afkRequests: [],
		authorizationHeaders: [],
		heartbeats: [],
		connections: [],
		async close() {
			for (const socket of backend.connections) {
				socket.terminate();
			}
			websocketServer.close();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error === undefined) {
						resolve();
					} else {
						reject(error);
					}
				});
			});
		},
	};

	server.on("request", (request, response) => {
		void (async () => {
			const body = await text(request);
			if ((request.method === "GET" || request.method === "PUT") && request.url === "/api/v1/afk") {
				const parsedBody: unknown = body === "" ? null : JSON.parse(body);
				backend.afkRequests.push({
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization,
					contentType: request.headers["content-type"],
					body: parsedBody,
				});
				const status = request.method === "GET" ? (options.afkGetStatus ?? 200) : (options.afkPutStatus ?? 200);
				response.writeHead(status, {"Content-Type": "application/json"});
				const afk = request.method === "PUT" ? requireAfk(parsedBody) : (options.afk ?? true);
				response.end(JSON.stringify(request.method === "PUT" ? (options.afkPutBody ?? {afk}) : {afk}));
				return;
			}
			if (request.method === "POST" && request.url === "/api/v1/questions") {
				backend.batchBodies.push(JSON.parse(body));
				backend.authorizationHeaders.push(request.headers.authorization);
				response.writeHead(options.createStatus ?? 201, {"Content-Type": "application/json"});
				response.end(
					JSON.stringify(options.createBody ?? {batch_id: "bat_1", question_ids: ["bat_1:0", "bat_1:1"]}),
				);
				return;
			}
			if (request.method === "POST" && request.url === "/api/v1/pair/claim") {
				backend.claimBodies.push(JSON.parse(body));
				response.writeHead(options.claimStatus ?? 201, {"Content-Type": "application/json"});
				response.end(
					JSON.stringify(options.claimBody ?? {token: MOCK_MACHINE_TOKEN, credential_type: "machine"}),
				);
				return;
			}
			response.writeHead(404);
			response.end();
		})();
	});

	server.on("upgrade", (request, socket, head) => {
		websocketServer.handleUpgrade(request, socket, head, (websocket) => {
			backend.connections.push(websocket);
			websocket.on("message", (data) => {
				backend.heartbeats.push(String(data));
			});
			options.onConnection?.(websocket, backend);
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("mock backend failed to bind a port");
	}
	backend.baseUrl = `http://127.0.0.1:${address.port}`;
	return backend;
}
