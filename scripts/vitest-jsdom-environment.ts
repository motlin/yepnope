import {builtinEnvironments, type Environment} from "vitest/runtime";

export default {
	...builtinEnvironments.jsdom,
	name: "project-jsdom",
} satisfies Environment;
