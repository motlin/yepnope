import {cloudflareTest, readD1Migrations} from "@cloudflare/vitest-pool-workers";
import {randomBytes} from "node:crypto";
import {defineConfig} from "vitest/config";

const TEST_VAPID_PRIVATE_JWK =
	'{"kty":"EC","crv":"P-256","x":"P2UcKzI-O7pCxMgZn7O1nuxR0PhhT6mT6tOykdMFguU","y":"l-fC1-ic-sn3gMPXjJdSkP_PS55_eSOZ6WNobUL0gto","d":"Ns5xclmJIPX3nl-JGchKKjUTJsrYm-TTrhG0UKSjjXc"}';

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./worker/migrations/d1");
	const authenticationSecret = randomBytes(32).toString("base64url");
	return {
		plugins: [
			cloudflareTest({
				wrangler: {configPath: "./wrangler.jsonc"},
				miniflare: {
					bindings: {
						BETTER_AUTH_SECRET: authenticationSecret,
						TEST_MIGRATIONS: migrations,
						VAPID_PRIVATE_JWK: TEST_VAPID_PRIVATE_JWK,
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
