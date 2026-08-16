import {cloudflareTest, readD1Migrations} from "@cloudflare/vitest-pool-workers";
import {defineConfig} from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./worker/migrations/d1");
	return {
		plugins: [
			cloudflareTest({
				wrangler: {configPath: "./wrangler.jsonc"},
				miniflare: {bindings: {TEST_MIGRATIONS: migrations}},
			}),
		],
		test: {
			include: ["worker/tests/**/*.test.ts"],
			setupFiles: ["./worker/tests/apply-migrations.ts"],
		},
	};
});
