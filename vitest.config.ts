import {defineConfig, mergeConfig} from "vite-plus";
import viteConfig from "./vite.config";

// TODO: Re-enable Storybook browser tests when @storybook/addon-vitest is compatible with vite-plus's bundled vitest.
// See: https://github.com/storybookjs/storybook/issues/33287
export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
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
