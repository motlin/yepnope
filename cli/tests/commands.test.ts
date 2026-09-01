import {afterEach, describe, expect, it, vi} from "vitest";
import {runAfkCommand} from "../afk";
import {credentialStore, storedCredential, type CredentialStore} from "../credentials";
import {runHookCommand} from "../hook";
import {runLoginCommand, runLogoutCommand} from "../login";
import {fakeKeychain} from "./fake-keychain";

const BASE_URL = "https://yepnope.app";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
}

async function signedInStore(): Promise<CredentialStore> {
	const store = credentialStore(BASE_URL, fakeKeychain());
	await store.save(
		storedCredential("client-1", {accessToken: "live-token", expiresAt: Date.now() + 600_000, refreshToken: "rt"}),
	);
	return store;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("yepnope login", () => {
	it("prints a code to approve in a browser and stores what the approval mints", async () => {
		const responses = [
			jsonResponse({client_id: "registered-client"}, 201),
			jsonResponse({
				device_code: "device-code-value",
				expires_in: 600,
				interval: 5,
				user_code: "WGHL5UTV",
				verification_uri: `${BASE_URL}/device`,
				verification_uri_complete: `${BASE_URL}/device?user_code=WGHL5UTV`,
			}),
			jsonResponse({error: "authorization_pending", error_description: "Authorization pending"}, 400),
			jsonResponse({access_token: "issued-access", expires_in: 600, refresh_token: "issued-refresh"}),
		];
		vi.stubGlobal("fetch", async () => Promise.resolve(responses.shift() ?? jsonResponse({}, 500)));
		const store = credentialStore(BASE_URL, fakeKeychain());
		const written: string[] = [];
		const waits: number[] = [];

		await runLoginCommand({
			baseUrl: BASE_URL,
			clientName: "YepNope hook on test-machine",
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
				return Promise.resolve();
			},
			store,
			write: (text) => written.push(text),
		});
		const stored = await store.load();

		expect({
			clientId: stored?.clientId,
			// 📟 The code is displayed the way it is read aloud, not the way it is stored.
			printedCode: written[0]?.includes("WGHL-5UTV"),
			printedUrl: written[0]?.includes(`${BASE_URL}/device?user_code=WGHL5UTV`),
			refreshToken: stored?.refreshToken,
			waits,
		}).toStrictEqual({
			clientId: "registered-client",
			printedCode: true,
			printedUrl: true,
			refreshToken: "issued-refresh",
			waits: [5_000, 5_000],
		});
	});

	it("backs off when the service says it is polling too fast", async () => {
		const responses = [
			jsonResponse({client_id: "registered-client"}, 201),
			jsonResponse({
				device_code: "device-code-value",
				expires_in: 600,
				interval: 5,
				user_code: "WGHL5UTV",
				verification_uri: `${BASE_URL}/device`,
			}),
			jsonResponse({error: "slow_down", error_description: "Polling too frequently"}, 400),
			jsonResponse({access_token: "issued-access", expires_in: 600, refresh_token: "issued-refresh"}),
		];
		vi.stubGlobal("fetch", async () => Promise.resolve(responses.shift() ?? jsonResponse({}, 500)));
		const waits: number[] = [];

		await runLoginCommand({
			baseUrl: BASE_URL,
			clientName: "YepNope hook on test-machine",
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
				return Promise.resolve();
			},
			store: credentialStore(BASE_URL, fakeKeychain()),
			write: () => undefined,
		});

		expect(waits).toStrictEqual([5_000, 10_000]);
	});

	it("keeps waiting when a poll dies on the network rather than the service", async () => {
		const responses = [
			async () => Promise.resolve(jsonResponse({client_id: "registered-client"}, 201)),
			async () =>
				Promise.resolve(
					jsonResponse({
						device_code: "device-code-value",
						expires_in: 600,
						interval: 5,
						user_code: "WGHL5UTV",
						verification_uri: `${BASE_URL}/device`,
					}),
				),
			async () => Promise.reject(new TypeError("fetch failed")),
			async () => Promise.resolve(jsonResponse({error: "authorization_pending"}, 400)),
			async () =>
				Promise.resolve(
					jsonResponse({access_token: "issued-access", expires_in: 600, refresh_token: "issued-refresh"}),
				),
		];
		vi.stubGlobal("fetch", async () =>
			(responses.shift() ?? (async () => Promise.resolve(jsonResponse({}, 500))))(),
		);
		const store = credentialStore(BASE_URL, fakeKeychain());
		const waits: number[] = [];

		await runLoginCommand({
			baseUrl: BASE_URL,
			clientName: "YepNope hook on test-machine",
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
				return Promise.resolve();
			},
			store,
			write: () => undefined,
		});
		const stored = await store.load();

		expect({refreshToken: stored?.refreshToken, waits}).toStrictEqual({
			refreshToken: "issued-refresh",
			waits: [5_000, 5_000, 5_000],
		});
	});

	it("stops with the service's own reason when the account denies the code", async () => {
		const responses = [
			jsonResponse({client_id: "registered-client"}, 201),
			jsonResponse({
				device_code: "device-code-value",
				expires_in: 600,
				interval: 5,
				user_code: "WGHL5UTV",
				verification_uri: `${BASE_URL}/device`,
			}),
			jsonResponse({error: "access_denied", error_description: "Access denied"}, 400),
		];
		vi.stubGlobal("fetch", async () => Promise.resolve(responses.shift() ?? jsonResponse({}, 500)));

		await expect(
			runLoginCommand({
				baseUrl: BASE_URL,
				clientName: "YepNope hook on test-machine",
				sleep: async () => Promise.resolve(),
				store: credentialStore(BASE_URL, fakeKeychain()),
				write: () => undefined,
			}),
		).rejects.toThrow("Access denied");
	});
});

describe("yepnope logout", () => {
	it("revokes the credential before forgetting it", async () => {
		const requests: Array<Record<string, string>> = [];
		vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
			requests.push(Object.fromEntries(new URLSearchParams(init.body as string)));
			return Promise.resolve(jsonResponse({}));
		});
		const store = await signedInStore();

		const message = await runLogoutCommand(BASE_URL, store);

		expect({loaded: await store.load(), message, requests}).toStrictEqual({
			loaded: null,
			message: "Signed out. The stored credential is revoked and removed from this machine's keychain.\n",
			requests: [{client_id: "client-1", token: "rt", token_type_hint: "refresh_token"}],
		});
	});

	it("says so plainly when there was nothing to sign out of", async () => {
		expect(await runLogoutCommand(BASE_URL, credentialStore(BASE_URL, fakeKeychain()))).toStrictEqual(
			`No YepNope credential was stored for ${BASE_URL}.\n`,
		);
	});
});

describe("yepnope hook", () => {
	it("hands the hook event to the service and returns its decision verbatim", async () => {
		const decision = {hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow"}}};
		const seen: RequestInit[] = [];
		vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
			seen.push(init);
			return Promise.resolve(jsonResponse(decision));
		});
		const payload = JSON.stringify({hook_event_name: "PermissionRequest", tool_name: "Bash"});

		const output = await runHookCommand(payload, {
			baseUrl: BASE_URL,
			store: await signedInStore(),
			writeError: () => undefined,
		});

		expect({
			authorization: (seen[0]?.headers as Record<string, string> | undefined)?.["Authorization"],
			body: seen[0]?.body,
			output: JSON.parse(output) as unknown,
		}).toStrictEqual({
			authorization: "Bearer live-token",
			body: payload,
			output: decision,
		});
	});

	// 🤐 Every one of these has to end in the native terminal prompt. A hook that fails loudly can
	// strand an agent because a laptop was offline, which is worse than not routing the question.
	it.each([
		{
			name: "the machine has never signed in",
			expectedError: "yepnope login",
			respond: async () => Promise.resolve(jsonResponse({})),
			store: async () => Promise.resolve(credentialStore(BASE_URL, fakeKeychain())),
		},
		{
			name: "the authorization was revoked",
			expectedError: "revoked or expired",
			respond: async () => Promise.resolve(new Response(null, {status: 401})),
			store: signedInStore,
		},
		{
			name: "the service is unreachable",
			expectedError: "could not reach",
			respond: async () => Promise.reject(new Error("ECONNREFUSED")),
			store: signedInStore,
		},
		{
			name: "the service is broken",
			expectedError: "HTTP 500",
			respond: async () => Promise.resolve(new Response(null, {status: 500})),
			store: signedInStore,
		},
	])("abstains, and says why on stderr, when $name", async ({expectedError, respond, store}) => {
		vi.stubGlobal("fetch", respond);
		const errors: string[] = [];

		const output = await runHookCommand("{}", {
			baseUrl: BASE_URL,
			store: await store(),
			writeError: (text) => errors.push(text),
		});

		expect({errorMentionsCause: errors.join("").includes(expectedError), output}).toStrictEqual({
			errorMentionsCause: true,
			output: "{}",
		});
	});
});

describe("yepnope afk", () => {
	it("reports and changes routing", async () => {
		const calls: Array<{body: unknown; method: string | undefined}> = [];
		vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
			calls.push({body: init.body, method: init.method});
			return Promise.resolve(jsonResponse({afk: init.method === "PUT"}));
		});
		const store = await signedInStore();

		expect({
			calls,
			off: await runAfkCommand(["off"], {baseUrl: BASE_URL, store}),
			status: await runAfkCommand([], {baseUrl: BASE_URL, store}),
		}).toStrictEqual({
			calls: [
				{body: JSON.stringify({afk: false}), method: "PUT"},
				{body: undefined, method: "GET"},
			],
			off: "AFK mode is now on. New questions will route to YepNope.\n",
			status: "AFK mode is off. New questions will use native prompts.\n",
		});
	});

	it("passes the service's own explanation through when routing cannot be turned on", async () => {
		vi.stubGlobal("fetch", async () =>
			Promise.resolve(
				jsonResponse(
					{
						error: "connected_mcp_client_required",
						message: "Authorize an MCP host or OAuth CLI client before turning AFK on.",
					},
					409,
				),
			),
		);

		await expect(runAfkCommand(["on"], {baseUrl: BASE_URL, store: await signedInStore()})).rejects.toThrow(
			"Authorize an MCP host or OAuth CLI client before turning AFK on.",
		);
	});

	it("never lets a status line block or throw", async () => {
		vi.stubGlobal("fetch", async () => Promise.reject(new Error("ECONNREFUSED")));

		expect({
			signedIn: await runAfkCommand(["statusline"], {baseUrl: BASE_URL, store: await signedInStore()}),
			signedOut: await runAfkCommand(["statusline"], {
				baseUrl: BASE_URL,
				store: credentialStore(BASE_URL, fakeKeychain()),
			}),
		}).toStrictEqual({
			signedIn: "⚠️ YepNope: UNKNOWN\n",
			signedOut: "⚠️ YepNope: NOT SIGNED IN\n",
		});
	});

	it("refuses an action it does not have", async () => {
		await expect(
			runAfkCommand(["maybe"], {baseUrl: BASE_URL, store: credentialStore(BASE_URL, fakeKeychain())}),
		).rejects.toThrow("usage: yepnope afk [status|on|off|statusline]");
	});
});
