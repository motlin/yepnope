import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {authenticationMethods} from "../auth";
import {API_ORIGIN, worker} from "./helpers";

describe("Authentication method availability", () => {
	it("offers email, magic link, and passkeys without any social provider configuration", () => {
		expect(authenticationMethods(env)).toStrictEqual({
			emailPassword: true,
			magicLink: true,
			passkey: true,
			social: [],
		});
	});

	it("enables a social provider only when both its client id and secret are configured", () => {
		expect(authenticationMethods({...env, GITHUB_CLIENT_ID: "github-client"}).social).toStrictEqual([]);
		expect(authenticationMethods({...env, GITHUB_CLIENT_SECRET: "github-secret"}).social).toStrictEqual([]);
		expect(
			authenticationMethods({...env, GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret"})
				.social,
		).toStrictEqual(["github"]);
	});

	it("treats blank provider credentials as absent", () => {
		expect(
			authenticationMethods({...env, GOOGLE_CLIENT_ID: "   ", GOOGLE_CLIENT_SECRET: "google-secret"}).social,
		).toStrictEqual([]);
	});

	it("reports every configured provider in a stable order", () => {
		expect(
			authenticationMethods({
				...env,
				GOOGLE_CLIENT_ID: "google-client",
				GOOGLE_CLIENT_SECRET: "google-secret",
				GITHUB_CLIENT_ID: "github-client",
				GITHUB_CLIENT_SECRET: "github-secret",
			}).social,
		).toStrictEqual(["github", "google"]);
	});
});

describe("Authentication method discovery", () => {
	it("tells the signed-out browser which methods this deployment offers", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/auth-methods`);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(await response.json()).toStrictEqual({
			email_password: true,
			magic_link: true,
			passkey: true,
			social: [],
		});
	});

	it("answers reads only, so a write falls through to the authenticated routes", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/auth-methods`, {method: "POST"});

		expect(response.status).toBe(401);
	});
});
