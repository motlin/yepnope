import {createServer, type Server} from "node:http";
import {memoryAdapter, type MemoryDB} from "@better-auth/memory-adapter";
import {mcp, requireMcpAuth} from "@better-auth/mcp";
import {type AuthInfo, McpServer, WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/server";
import {betterAuth} from "better-auth";
import {jwt} from "better-auth/plugins";
import {z} from "zod";

export const PROOF_SCOPES = ["openid", "offline_access", "yepnope:questions"] as const;
export const QUESTION_SCOPE = "yepnope:questions";
const TEST_PASSWORD = "correct-horse-battery-staple";

const AUTHENTICATION_PATH = "/api/auth";
const MEMORY_MODELS = [
	"user",
	"session",
	"account",
	"verification",
	"jwks",
	"oauthClient",
	"oauthResource",
	"oauthClientResource",
	"oauthRefreshToken",
	"oauthAccessToken",
	"oauthConsent",
	"oauthClientAssertion",
] as const;

export interface OAuthTokens {
	access_token: string;
	expires_at: number;
	expires_in: number;
	id_token: string;
	refresh_token: string;
	scope: string;
	token_type: string;
}

export interface ProofServer {
	authentication: ReturnType<typeof createProofAuthentication>;
	cancellationObserved: Promise<void>;
	close: () => Promise<void>;
	database: MemoryDB;
	fetch: (request: Request) => Promise<Response>;
	issuer: string;
	origin: string;
	resource: string;
}

export interface ProofServerOptions {
	allowDynamicClientRegistration?: boolean;
	port?: number;
}

interface ProofMcpHandler {
	close: () => Promise<void>;
	fetch: (request: Request, authInfo: AuthInfo) => Promise<Response>;
}

function createProofDatabase(): MemoryDB {
	return Object.fromEntries(MEMORY_MODELS.map((model) => [model, []]));
}

function createProofAuthentication(
	origin: string,
	resource: string,
	database: MemoryDB,
	allowDynamicClientRegistration: boolean,
) {
	return betterAuth({
		appName: "YepNope OAuth MCP proof",
		baseURL: origin,
		basePath: AUTHENTICATION_PATH,
		secret: "local-proof-secret-with-more-than-thirty-two-characters",
		trustedOrigins: [origin],
		database: memoryAdapter(database),
		emailAndPassword: {enabled: true},
		plugins: [
			jwt(),
			// @ts-expect-error Better Auth 1.7 plugin metadata conflicts with exactOptionalPropertyTypes.
			mcp({
				allowDynamicClientRegistration,
				allowUnauthenticatedClientRegistration: allowDynamicClientRegistration,
				loginPage: "/proof/login",
				consentPage: "/proof/consent",
				resource,
				scopes: [...PROOF_SCOPES],
				refreshTokenReuseInterval: 0,
				accessTokenExpiresIn: 60,
			}),
		],
	});
}

function tokenFrom(request: Request): string {
	const authorization = request.headers.get("Authorization");
	if (authorization === null || !authorization.startsWith("Bearer ")) {
		throw new Error("protected handler received no bearer token");
	}
	return authorization.slice("Bearer ".length);
}

function authInfoFrom(request: Request, claims: Record<string, unknown>, resource: string): AuthInfo {
	const clientId = claims["client_id"];
	const scope = claims["scope"];
	if (typeof clientId !== "string" || typeof scope !== "string") {
		throw new Error("access token is missing MCP client claims");
	}
	return {
		token: tokenFrom(request),
		clientId,
		scopes: scope.split(" "),
		resource: new URL(resource),
		extra: {subject: claims["sub"]},
	};
}

function createProofMcpHandler(observeCancellation: () => void): ProofMcpHandler {
	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
	const servers = new Set<McpServer>();
	return {
		close: async () => {
			await Promise.all(Array.from(servers, async (server) => server.close()));
		},
		fetch: async (request, authInfo) => {
			const sessionId = request.headers.get("mcp-session-id");
			let transport = sessionId === null ? undefined : transports.get(sessionId);
			if (sessionId !== null && transport === undefined) {
				return Response.json(
					{error: {code: -32_001, message: "Session not found"}, id: null, jsonrpc: "2.0"},
					{status: 404},
				);
			}
			if (transport === undefined) {
				const server = new McpServer({name: "yepnope-oauth-proof", version: "1.0.0"});
				servers.add(server);
				const createdTransport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: () => crypto.randomUUID(),
					enableJsonResponse: false,
					keepAliveMs: 50,
					onsessioninitialized: (initializedSessionId) => {
						transports.set(initializedSessionId, createdTransport);
					},
					onsessionclosed: (closedSessionId) => {
						transports.delete(closedSessionId);
					},
				});
				transport = createdTransport;
				server.registerTool(
					"protected_echo",
					{
						description: "Returns the authenticated subject and supplied text.",
						inputSchema: z.object({text: z.string()}),
					},
					async ({text}, context) =>
						Promise.resolve({
							content: [
								{
									type: "text",
									text: JSON.stringify({subject: context.http?.authInfo?.extra?.["subject"], text}),
								},
							],
						}),
				);
				server.registerTool(
					"ask_yep_nope",
					{
						description: "Waits for a test answer until the client cancels.",
						inputSchema: z.object({question: z.string()}),
					},
					async (_input, context) =>
						new Promise<{content: Array<{text: string; type: "text"}>}>((_resolve, reject) => {
							context.mcpReq.signal.addEventListener(
								"abort",
								() => {
									observeCancellation();
									reject(new DOMException("MCP request cancelled", "AbortError"));
								},
								{once: true},
							);
						}),
				);
				await server.connect(createdTransport);
			}
			return transport.handleRequest(request, {authInfo});
		},
	};
}

async function writeNodeResponse(response: Response, nodeResponse: import("node:http").ServerResponse): Promise<void> {
	response.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
	nodeResponse.statusCode = response.status;
	if (response.body === null) {
		nodeResponse.end();
		return;
	}
	const reader = response.body.getReader();
	for (;;) {
		const {done, value} = await reader.read();
		if (done) {
			nodeResponse.end();
			return;
		}
		nodeResponse.write(value);
	}
}

function proofBrowserPage(kind: "consent" | "login"): Response {
	const endpoint = kind === "login" ? "/api/auth/sign-in/email" : "/api/auth/oauth2/consent";
	const body =
		kind === "login"
			? `{email:"alice@example.com",password:${JSON.stringify(TEST_PASSWORD)},oauth_query:location.search.slice(1)}`
			: `{accept:true,oauth_query:location.search.slice(1)}`;
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>OAuth proof ${kind}</title><script>fetch(${JSON.stringify(endpoint)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(${body})}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));location.href=result.url}).catch(error=>document.body.textContent=String(error))</script>`,
		{headers: {"Content-Type": "text/html; charset=utf-8"}},
	);
}

async function requestBody(nodeRequest: import("node:http").IncomingMessage): Promise<string | undefined> {
	if (nodeRequest.method === "GET" || nodeRequest.method === "HEAD") {
		return undefined;
	}
	const chunks: Uint8Array[] = [];
	for await (const untrustedChunk of nodeRequest) {
		const chunk: unknown = untrustedChunk;
		if (typeof chunk === "string") {
			chunks.push(Buffer.from(chunk));
		} else if (chunk instanceof Uint8Array) {
			chunks.push(chunk);
		} else {
			throw new TypeError("proof server received an unsupported request chunk");
		}
	}
	return Buffer.concat(chunks).toString();
}

async function listen(server: Server, requestedPort: number): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(requestedPort, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("proof server did not bind a TCP port");
	}
	return address.port;
}

export async function startProofServer(options: ProofServerOptions = {}): Promise<ProofServer> {
	let dispatch = async (_request: Request) =>
		Promise.resolve(new Response("proof server is initializing", {status: 503}));
	let port = 0;
	const server = createServer((nodeRequest, nodeResponse) => {
		const abortController = new AbortController();
		nodeRequest.once("aborted", () => {
			abortController.abort();
		});
		nodeResponse.once("close", () => {
			if (!nodeResponse.writableEnded) {
				abortController.abort();
			}
		});
		void (async () => {
			const requestUrl = `http://127.0.0.1:${String(port)}${nodeRequest.url ?? "/"}`;
			const body = await requestBody(nodeRequest);
			const headers = new Headers();
			for (const [name, value] of Object.entries(nodeRequest.headers)) {
				if (Array.isArray(value)) {
					for (const item of value) {
						headers.append(name, item);
					}
				} else if (value !== undefined) {
					headers.set(name, value);
				}
			}
			const request = new Request(requestUrl, {
				method: nodeRequest.method ?? "GET",
				headers,
				...(body === undefined ? {} : {body}),
				signal: abortController.signal,
			});
			await writeNodeResponse(await dispatch(request), nodeResponse);
		})().catch((error: unknown) => {
			if (!nodeResponse.headersSent) {
				nodeResponse.statusCode = 500;
			}
			nodeResponse.end(error instanceof Error ? error.message : "unknown proof server error");
		});
	});
	port = await listen(server, options.port ?? 0);
	const origin = `http://127.0.0.1:${String(port)}`;
	const issuer = `${origin}${AUTHENTICATION_PATH}`;
	const resource = `${origin}/mcp`;
	const database = createProofDatabase();
	const authentication = createProofAuthentication(
		origin,
		resource,
		database,
		options.allowDynamicClientRegistration ?? false,
	);
	await authentication.$context;

	let observeCancellation: () => void = () => {
		throw new Error("cancellation observer was called before initialization");
	};
	const cancellationObserved = new Promise<void>((resolve) => {
		observeCancellation = resolve;
	});
	const mcpHandler = createProofMcpHandler(observeCancellation);
	const protectedMcpHandler = requireMcpAuth(
		authentication,
		async (request, claims) => mcpHandler.fetch(request, authInfoFrom(request, claims, resource)),
		{
			issuer,
			resource,
			requiredScopes: [QUESTION_SCOPE],
			challengeScopes: [...PROOF_SCOPES],
		},
	);

	const route = async (request: Request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/mcp") {
			return protectedMcpHandler(request);
		}
		if (pathname === "/proof/login") {
			return proofBrowserPage("login");
		}
		if (pathname === "/proof/consent") {
			return proofBrowserPage("consent");
		}
		return authentication.handler(request);
	};
	dispatch = route;

	return {
		authentication,
		cancellationObserved,
		close: async () => {
			await mcpHandler.close();
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
		database,
		fetch: route,
		issuer,
		origin,
		resource,
	};
}

function sessionCookie(response: Response): string {
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (cookie === undefined) {
		throw new Error("authentication response did not set a session cookie");
	}
	return cookie;
}

export async function createProofBrowserSession(proof: ProofServer): Promise<string> {
	const response = await fetch(`${proof.issuer}/sign-up/email`, {
		method: "POST",
		headers: {"Content-Type": "application/json", Origin: proof.origin},
		body: JSON.stringify({
			email: "alice@example.com",
			name: "Alice",
			password: TEST_PASSWORD,
		}),
	});
	if (!response.ok) {
		throw new Error(`local proof sign-up failed with ${String(response.status)}`);
	}
	return sessionCookie(response);
}

export async function createFixedClient(proof: ProofServer, cookie: string, redirectUri: string): Promise<string> {
	const response = await fetch(`${proof.issuer}/oauth2/create-client`, {
		method: "POST",
		headers: {"Content-Type": "application/json", Cookie: cookie, Origin: proof.origin},
		body: JSON.stringify({
			application_type: "native",
			client_name: "Codex local OAuth proof",
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris: [redirectUri],
			response_types: ["code"],
			scope: PROOF_SCOPES.join(" "),
			token_endpoint_auth_method: "none",
		}),
	});
	if (!response.ok) {
		throw new Error(`fixed-client registration failed with ${String(response.status)}: ${await response.text()}`);
	}
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("client_id" in body) || typeof body.client_id !== "string") {
		throw new Error("fixed-client registration returned no client_id");
	}
	return body.client_id;
}

export async function proofPkce(): Promise<{challenge: string; verifier: string}> {
	const verifier = "proof-verifier-000000000000000000000000000000000000000000000000";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return {
		challenge: Buffer.from(digest).toString("base64url"),
		verifier,
	};
}

export async function signProofJwt(proof: ProofServer, payload: Record<string, unknown>): Promise<string> {
	// oxlint-disable typescript/no-unsafe-call -- The adjacent Better Auth type defect makes this API `error`.
	// @ts-expect-error Better Auth 1.7 loses jwt API inference when combined with its MCP plugin types.
	const result: unknown = await proof.authentication.api.signJWT({body: {payload}});
	// oxlint-enable typescript/no-unsafe-call
	if (typeof result !== "object" || result === null || !("token" in result) || typeof result.token !== "string") {
		throw new Error("proof JWT signing returned no token");
	}
	return result.token;
}
