import {spawnSync} from "node:child_process";
import {generateKeyPairSync, randomBytes} from "node:crypto";
import {existsSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

/** A command the harness runs itself, kept as data so the split between preparing and serving is testable. */
export interface HarnessCommand {
	readonly command: string;
	readonly arguments_: readonly string[];
}

export const repositoryDirectory = resolve(import.meta.dirname, "..");
const builtClientEntry = resolve(repositoryDirectory, "dist/index.html");
const stateDirectory = resolve(repositoryDirectory, ".llm/browser-e2e-state");
const environmentFile = resolve(repositoryDirectory, ".llm/browser-e2e.env");

const serverPort = "4173";
export const SERVER_ORIGIN = `https://localhost:${serverPort}`;

// 🏗️ Preparing is the slow half: a cold `vp build` can take several minutes, which is why it runs
// as its own step instead of inside the process Playwright puts a start-up timeout on.
export const PREPARE_COMMANDS: readonly HarnessCommand[] = [
	{command: "vp", arguments_: ["build"]},
	{
		command: "vp",
		arguments_: [
			"exec",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			"DB",
			"--config",
			"wrangler.e2e.jsonc",
			"--local",
			"--persist-to",
			stateDirectory,
		],
	},
];

// 🚀 Serving is the fast half: everything it needs is already on disk, so Playwright only waits for
// `wrangler dev` to bind the port.
export const SERVE_COMMAND: HarnessCommand = {
	command: "vp",
	arguments_: [
		"exec",
		"wrangler",
		"dev",
		"--config",
		"wrangler.e2e.jsonc",
		"--local",
		"--persist-to",
		stateDirectory,
		"--port",
		serverPort,
		"--local-protocol",
		"https",
		"--env-file",
		environmentFile,
		"--log-level",
		"error",
		"--show-interactive-dev-session",
		"false",
	],
};

export const BROWSER_TEST_PREPARE_COMMAND = "node --experimental-strip-types scripts/browser-test-prepare.ts";
export const BROWSER_TEST_SERVE_COMMAND = "node --experimental-strip-types scripts/browser-test-server.ts";

export function removeTestState(): void {
	rmSync(stateDirectory, {force: true, recursive: true});
	rmSync(environmentFile, {force: true});
}

/** Build the Worker, seed its secrets, and migrate its database so the server has something to serve. */
export function prepareBrowserTests(): void {
	const testVapidPrivateJwk = JSON.stringify(
		generateKeyPairSync("ec", {namedCurve: "P-256"}).privateKey.export({format: "jwk"}),
	);
	try {
		removeTestState();
		mkdirSync(stateDirectory, {recursive: true});
		writeFileSync(
			environmentFile,
			[
				`BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`,
				`VAPID_PRIVATE_JWK='${testVapidPrivateJwk}'`,
				"",
			].join("\n"),
			{mode: 0o600},
		);
		for (const {command, arguments_} of PREPARE_COMMANDS) {
			const result = spawnSync(command, [...arguments_], {
				cwd: repositoryDirectory,
				env: {...process.env, CI: "true", VITE_APPLICATION_VERSION: "browser-version-n"},
				stdio: "inherit",
			});
			if (result.status !== 0) {
				throw new Error(`${command} failed while preparing the browser test server`);
			}
		}
	} catch (error) {
		removeTestState();
		throw error;
	}
}

/** Refuse to serve state that `prepareBrowserTests` never produced, rather than serving a stale build. */
export function requirePreparedBrowserTests(): void {
	const missing = [builtClientEntry, stateDirectory, environmentFile].filter((path) => !existsSync(path));
	if (missing.length > 0) {
		throw new Error(
			`the browser test server is not prepared (missing ${missing.join(", ")}); run \`vp run test:browser\`, which runs \`${BROWSER_TEST_PREPARE_COMMAND}\` first`,
		);
	}
}
