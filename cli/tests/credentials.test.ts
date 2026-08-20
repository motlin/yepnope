import {afterEach, describe, expect, it, vi} from "vitest";
import {accessToken, credentialStore, NotSignedInError, storedCredential} from "../credentials";
import {fakeKeychain} from "./fake-keychain";

const BASE_URL = "https://yepnope.app";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the stored hook credential", () => {
	it("keeps one record per service origin", async () => {
		const keychain = fakeKeychain();
		await credentialStore("https://yepnope.app/device?user_code=ABCD", keychain).save(
			storedCredential("production-client", {accessToken: "a", expiresAt: 1, refreshToken: "r"}),
		);
		await credentialStore("http://localhost:5173", keychain).save(
			storedCredential("development-client", {accessToken: "b", expiresAt: 2, refreshToken: "s"}),
		);

		expect([...keychain.entries.keys()].sort()).toStrictEqual(["http://localhost:5173", "https://yepnope.app"]);
	});

	it("round-trips through the keychain", async () => {
		const store = credentialStore(BASE_URL, fakeKeychain());
		const credential = storedCredential("client-1", {accessToken: "at", expiresAt: 1_000, refreshToken: "rt"});
		await store.save(credential);

		expect(await store.load()).toStrictEqual(credential);
	});

	it("reports a keychain entry it cannot parse as no credential at all", async () => {
		const store = credentialStore(BASE_URL, fakeKeychain({[BASE_URL]: '{"clientId":"only-half-a-record"}'}));

		expect(await store.load()).toBeNull();
	});

	it("forgets the credential on logout", async () => {
		const keychain = fakeKeychain();
		const store = credentialStore(BASE_URL, keychain);
		await store.save(storedCredential("client-1", {accessToken: "at", expiresAt: 1_000, refreshToken: "rt"}));
		await store.clear();

		expect({entries: [...keychain.entries.keys()], loaded: await store.load()}).toStrictEqual({
			entries: [],
			loaded: null,
		});
	});
});

describe("using the stored credential", () => {
	it("names the command that fixes it when nothing is stored", async () => {
		const store = credentialStore(BASE_URL, fakeKeychain());

		await expect(accessToken(BASE_URL, store)).rejects.toThrow(NotSignedInError);
		await expect(accessToken(BASE_URL, store)).rejects.toThrow("yepnope login");
	});

	it("reuses an access token that has not expired, without calling the service", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", () => {
			calls += 1;
			throw new Error("a live access token must not be refreshed");
		});
		const store = credentialStore(BASE_URL, fakeKeychain());
		await store.save(storedCredential("client-1", {accessToken: "live", expiresAt: 2_000, refreshToken: "rt"}));

		expect({calls, token: await accessToken(BASE_URL, store, 1_000)}).toStrictEqual({
			calls: 0,
			token: "live",
		});
	});

	it("refreshes a spent token and stores the rotated refresh token", async () => {
		const requests: Array<{body: string; url: string}> = [];
		vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
			requests.push({body: String(init.body), url: String(url)});
			return Promise.resolve(
				jsonResponse({access_token: "fresh", expires_in: 600, refresh_token: "rotated-refresh-token"}),
			);
		});
		const store = credentialStore(BASE_URL, fakeKeychain());
		await store.save(storedCredential("client-1", {accessToken: "spent", expiresAt: 1_000, refreshToken: "old"}));

		const token = await accessToken(BASE_URL, store, 2_000);
		const stored = await store.load();

		expect({
			body: Object.fromEntries(new URLSearchParams(requests[0]?.body)),
			refreshToken: stored?.refreshToken,
			token,
			url: requests[0]?.url,
		}).toStrictEqual({
			body: {
				client_id: "client-1",
				grant_type: "refresh_token",
				refresh_token: "old",
				resource: "https://yepnope.app/mcp",
			},
			// 🔁 Refresh tokens rotate on every use, so a run that forgot to write the new one back
			// would leave the next run holding a token the service has already retired.
			refreshToken: "rotated-refresh-token",
			token: "fresh",
			url: "https://yepnope.app/api/auth/oauth2/token",
		});
	});

	it("uses what another process refreshed rather than failing the race", async () => {
		const keychain = fakeKeychain();
		const store = credentialStore(BASE_URL, keychain);
		await store.save(storedCredential("client-1", {accessToken: "spent", expiresAt: 1_000, refreshToken: "old"}));
		vi.stubGlobal("fetch", async () => {
			// The winner rotates the token and writes it back while this call is in flight.
			await store.save(
				storedCredential("client-1", {accessToken: "someone-elses", expiresAt: 9_000, refreshToken: "new"}),
			);
			return Promise.resolve(jsonResponse({error: "invalid_grant", error_description: "Invalid refresh"}, 400));
		});

		expect(await accessToken(BASE_URL, store, 2_000)).toStrictEqual("someone-elses");
	});

	it("reports a refusal to refresh instead of silently reusing the dead token", async () => {
		vi.stubGlobal("fetch", async () =>
			Promise.resolve(jsonResponse({error: "invalid_grant", error_description: "Invalid refresh token"}, 400)),
		);
		const store = credentialStore(BASE_URL, fakeKeychain());
		await store.save(storedCredential("client-1", {accessToken: "spent", expiresAt: 1_000, refreshToken: "old"}));

		await expect(accessToken(BASE_URL, store, 2_000)).rejects.toThrow("Invalid refresh token");
	});
});
