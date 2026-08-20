import {cloudflareTest, readD1Migrations} from "@cloudflare/vitest-pool-workers";
import {randomBytes} from "node:crypto";
import {defineConfig} from "vitest/config";
import {createTestSiteverify, TURNSTILE_TEST_KEYS} from "./worker/turnstile-test-siteverify";

const TEST_VAPID_PRIVATE_JWK =
	'{"kty":"EC","crv":"P-256","x":"P2UcKzI-O7pCxMgZn7O1nuxR0PhhT6mT6tOykdMFguU","y":"l-fC1-ic-sn3gMPXjJdSkP_PS55_eSOZ6WNobUL0gto","d":"Ns5xclmJIPX3nl-JGchKKjUTJsrYm-TTrhG0UKSjjXc"}';

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./worker/migrations/d1");
	const authenticationSecret = randomBytes(32).toString("base64url");
	// 🤖 The suite runs against a production-shaped origin, where human verification is mandatory.
	// Cloudflare's documented always-pass test keys plus a local Siteverify keep the gate real and
	// the outcome deterministic, with no network call and no shared account at Cloudflare.
	const siteverify = createTestSiteverify();
	return {
		plugins: [
			cloudflareTest({
				wrangler: {configPath: "./wrangler.jsonc"},
				miniflare: {
					bindings: {
						BETTER_AUTH_SECRET: authenticationSecret,
						TEST_MIGRATIONS: migrations,
						TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSecretKey,
						TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSiteKey,
						VAPID_PRIVATE_JWK: TEST_VAPID_PRIVATE_JWK,
					},
					serviceBindings: {
						// Miniflare hands its handler its own Request class, so the form body is
						// repackaged into the one the Worker's binding would have delivered.
						TURNSTILE_SITEVERIFY: async (request) =>
							siteverify.fetch(
								new Request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
									body: await request.text(),
									headers: {"Content-Type": "application/x-www-form-urlencoded"},
									method: "POST",
								}),
							),
					},
				},
			}),
		],
		test: {
			include: ["worker/tests/**/*.test.ts"],
			setupFiles: ["./worker/tests/apply-migrations.ts"],
		},
	};
});
