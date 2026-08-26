import {fileURLToPath} from "node:url";
import {defineConfig, mergeConfig} from "vite-plus";
import viteConfig from "./vite.config";

const projectJsdomEnvironment = fileURLToPath(new URL("./scripts/vitest-jsdom-environment.ts", import.meta.url));

// TODO: Re-enable Storybook browser tests when @storybook/addon-vitest is compatible with vite-plus's bundled vitest.
// See: https://github.com/storybookjs/storybook/issues/33287
export default mergeConfig(
	viteConfig,
	defineConfig({
		resolve: {
			alias: {
				"vitest-environment-project-jsdom": projectJsdomEnvironment,
			},
		},
		test: {
			exclude: ["**/node_modules/**", "tests/browser/**", "tests/deployed/**", "worker/**"],
			globals: true,
			environment: "node",
			pool: "threads",
			isolate: true,
			experimental: {
				fsModuleCache: true,
			},
		},
	}),
);
