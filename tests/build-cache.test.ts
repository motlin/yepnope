import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import viteConfig from "../vite.config";

const justfile = readFileSync(new URL("../justfile", import.meta.url), "utf8");

describe("cached client build", () => {
	// 🏷️ The build stamps the commit into the client and service worker, so the commit has to be a
	// cache input. A commit that touches no client source otherwise replays the previous build and
	// ships the previous version's stamp.
	it("keys the cached build on the commit it stamps into the application", () => {
		const buildRecipe = /^build:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/mu.exec(justfile)?.[1] ?? "";
		expect({
			task: viteConfig.run?.tasks?.["build"],
			recipeStampsTheCommit: buildRecipe.includes('VITE_APPLICATION_VERSION="$(git rev-parse HEAD)"'),
		}).toStrictEqual({
			task: {command: "vp build", env: ["VITE_APPLICATION_VERSION"]},
			recipeStampsTheCommit: true,
		});
	});
});
