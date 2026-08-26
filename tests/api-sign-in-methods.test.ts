// @vitest-environment project-jsdom
import {afterEach, describe, expect, it, vi} from "vitest";
import {
	ApiResponseError,
	deletePasskey,
	fetchAuthenticationMethods,
	fetchLinkedAccounts,
	fetchPasskeys,
	linkSocialAccount,
	registerPasskey,
	sendMagicLink,
	signInWithPasskey,
	startSocialSignIn,
	unlinkAccount,
} from "../src/api";

const startAuthentication = vi.hoisted(() => vi.fn<(_options: {optionsJSON: unknown}) => Promise<unknown>>());
const startRegistration = vi.hoisted(() => vi.fn<(_options: {optionsJSON: unknown}) => Promise<unknown>>());

vi.mock("@simplewebauthn/browser", () => ({startAuthentication, startRegistration}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

function respondWith(bodyForPath: (path: string) => unknown): ReturnType<typeof vi.fn<typeof fetch>> {
	const fetchMock = vi.fn<typeof fetch>(async (input) => Promise.resolve(Response.json(bodyForPath(String(input)))));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("authentication method discovery", () => {
	it("reads the deployment's offered methods", async () => {
		const fetchMock = respondWith(() => ({
			email_password: true,
			magic_link: true,
			passkey: true,
			social: ["github", "google"],
			turnstile_site_key: "1x00000000000000000000AA",
		}));

		expect(await fetchAuthenticationMethods()).toStrictEqual({
			emailPassword: true,
			magicLink: true,
			passkey: true,
			social: ["github", "google"],
			turnstileSiteKey: "1x00000000000000000000AA",
		});
		expect(fetchMock.mock.calls).toStrictEqual([["/api/v1/auth-methods", {credentials: "same-origin"}]]);
	});

	it("ignores a provider the client does not know how to render", async () => {
		respondWith(() => ({
			email_password: true,
			magic_link: false,
			passkey: true,
			social: ["github", "myspace"],
			turnstile_site_key: null,
		}));

		expect((await fetchAuthenticationMethods()).social).toStrictEqual(["github"]);
	});
});

describe("passwordless email sign-in", () => {
	it("asks the worker to email a sign-in link", async () => {
		const fetchMock = respondWith(() => ({
			message: "If the request can be completed, check your inbox for next steps.",
			status: true,
		}));

		await sendMagicLink("alice@example.com", null);

		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/sign-in/magic-link",
				{
					credentials: "same-origin",
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({email: "alice@example.com", callbackURL: "/"}),
				},
			],
		]);
	});

	// ✉️ Better Auth decodes this callback a second time before it validates and follows it, so the
	// query has to arrive encoded to survive the round trip. A signed authorization request is
	// dense with percent-encoded colons and slashes, and one decode too many turns it into a URL
	// the Worker refuses to redirect to — stranding the MCP client that sent the visitor here.
	it("encodes the pending authorization the emailed link has to survive", async () => {
		const fetchMock = respondWith(() => ({
			message: "If the request can be completed, check your inbox for next steps.",
			status: true,
		}));
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: "https://yepnope.example/mcp",
			scope: "openid offline_access yepnope:questions",
			sig: "signed-authorization-request",
		}).toString();

		await sendMagicLink("alice@example.com", null, `/sign-in?${oauthQuery}`);

		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/sign-in/magic-link",
				{
					credentials: "same-origin",
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({
						email: "alice@example.com",
						callbackURL: `/sign-in?${encodeURIComponent(oauthQuery)}`,
					}),
				},
			],
		]);
	});
});

describe("social sign-in", () => {
	it("returns the provider authorization URL to navigate to", async () => {
		const fetchMock = respondWith(() => ({redirect: true, url: "https://github.com/login/oauth/authorize?x=1"}));

		expect(await startSocialSignIn("github", "/")).toBe("https://github.com/login/oauth/authorize?x=1");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/sign-in/social");
	});

	it("links a provider to the signed-in account through the same redirect", async () => {
		const fetchMock = respondWith(() => ({redirect: true, url: "https://accounts.google.com/o/oauth2/auth?x=1"}));

		expect(await linkSocialAccount("google", "/settings")).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/link-social");
	});

	it("refuses a redirect that is not HTTP", async () => {
		respondWith(() => ({redirect: true, url: "javascript:alert(1)"}));

		await expect(startSocialSignIn("github", "/")).rejects.toThrow(TypeError);
	});

	it("lists the providers already linked to the account", async () => {
		respondWith(() => [
			{id: "account-credential", providerId: "credential", accountId: "alice", scopes: []},
			{id: "account-github", providerId: "github", accountId: "12345", scopes: ["user:email"]},
		]);

		expect(await fetchLinkedAccounts()).toStrictEqual([
			{id: "account-credential", provider: "credential"},
			{id: "account-github", provider: "github"},
		]);
	});

	it("unlinks a provider by its account id", async () => {
		const fetchMock = respondWith(() => ({status: true}));

		await unlinkAccount("account-github");

		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/unlink-account",
				{
					credentials: "same-origin",
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({accountId: "account-github"}),
				},
			],
		]);
	});

	it("surfaces the worker's refusal to unlink the last sign-in method", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () =>
				Promise.resolve(Response.json({message: "You can't unlink your last account"}, {status: 400})),
			),
		);

		await expect(unlinkAccount("account-github")).rejects.toThrow(ApiResponseError);
	});
});

describe("passkeys", () => {
	it("runs the registration ceremony and names the credential", async () => {
		const options = {challenge: "registration-challenge", rp: {id: "yepnope.app", name: "YepNope"}};
		const attestation = {id: "credential-id", type: "public-key"};
		startRegistration.mockResolvedValue(attestation);
		const fetchMock = respondWith((path) =>
			path.includes("generate-register-options") ? options : {id: "passkey-id"},
		);

		await registerPasskey("Alice phone");

		expect(startRegistration.mock.calls).toStrictEqual([[{optionsJSON: options}]]);
		expect(fetchMock.mock.calls[1]).toStrictEqual([
			"/api/auth/passkey/verify-registration",
			{
				credentials: "same-origin",
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({response: attestation, name: "Alice phone"}),
			},
		]);
	});

	it("runs the authentication ceremony and returns the signed-in user", async () => {
		const options = {challenge: "authentication-challenge", rpId: "yepnope.app"};
		const assertion = {id: "credential-id", type: "public-key"};
		startAuthentication.mockResolvedValue(assertion);
		respondWith((path) =>
			path.includes("generate-authenticate-options")
				? options
				: {user: {id: "user-alice", email: "alice@example.com", emailVerified: true}},
		);

		expect(await signInWithPasskey()).toStrictEqual({
			id: "user-alice",
			email: "alice@example.com",
			emailVerified: true,
		});
		expect(startAuthentication.mock.calls).toStrictEqual([[{optionsJSON: options}]]);
	});

	it("reports a cancelled ceremony as a plain sign-in failure", async () => {
		startAuthentication.mockRejectedValue(new DOMException("The operation either timed out", "NotAllowedError"));
		respondWith(() => ({challenge: "authentication-challenge", rpId: "yepnope.app"}));

		await expect(signInWithPasskey()).rejects.toThrow("Passkey sign-in was cancelled.");
	});

	it("lists registered passkeys with a usable label", async () => {
		respondWith(() => [
			{id: "passkey-named", name: "Alice phone", createdAt: "2000-01-01T00:00:00.000Z", aaguid: null},
			{id: "passkey-unnamed", createdAt: "2000-01-02T00:00:00.000Z"},
		]);

		expect(await fetchPasskeys()).toStrictEqual([
			{id: "passkey-named", name: "Alice phone", createdAt: 946_684_800_000},
			{id: "passkey-unnamed", name: "Passkey", createdAt: 946_771_200_000},
		]);
	});

	it("deletes a passkey by id", async () => {
		const fetchMock = respondWith(() => ({status: true}));

		await deletePasskey("passkey-named");

		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/passkey/delete-passkey",
				{
					credentials: "same-origin",
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({id: "passkey-named"}),
				},
			],
		]);
	});
});
