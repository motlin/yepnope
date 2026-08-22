import {spawnSync} from "node:child_process";
import {generateKeyPairSync, randomBytes} from "node:crypto";
import {cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

/** A command the harness runs itself, kept as data so the split between preparing and serving is testable. */
export interface HarnessCommand {
	readonly command: string;
	readonly arguments_: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
}

export const repositoryDirectory = resolve(import.meta.dirname, "..");
const servedClientDirectory = resolve(repositoryDirectory, "dist");
const builtClientEntry = resolve(servedClientDirectory, "index.html");
const stateDirectory = resolve(repositoryDirectory, ".llm/browser-e2e-state");
const environmentFile = resolve(repositoryDirectory, ".llm/browser-e2e.env");

// 🔭 The two client builds the suite needs. The suite starts on the initial version and
// `service-worker-upgrade.spec.ts` proves the upgrade to the second one, so both are built before
// Playwright starts and the upgrade is a directory swap rather than a build.
export const INITIAL_APPLICATION_VERSION = "browser-version-n";
export const UPGRADED_APPLICATION_VERSION = "browser-version-n-plus-one";
const upgradedClientDirectory = resolve(repositoryDirectory, ".llm/browser-e2e-upgraded-client");

const serverPort = "4173";
export const SERVER_ORIGIN = `https://localhost:${serverPort}`;

// 📜 Where `wrangler dev` says what it is doing. Without this the server's own account of a reload,
// a crash, or a port it could not bind is discarded, and a failed spec is the only evidence left.
export const serverLogFile = resolve(repositoryDirectory, ".llm/browser-e2e-server.log");

/**
 * The line the server wrapper writes when `wrangler dev` exits without being asked to.
 *
 * Playwright stops watching the web server once it has started, so a server that dies mid-run
 * leaves every remaining spec failing on a refused connection — failures indistinguishable from a
 * product regression. This marker is how the reporter tells the two apart.
 */
export const SERVER_EXITED_MARKER = "the browser test server exited on its own";

// 🏗️ Preparing is the slow half: a cold `vp build` can take several minutes, which is why it runs
// as its own step instead of inside the process Playwright puts a start-up timeout on. Both client
// versions are built here, for the same reason: a build that runs once the server is up rewrites
// the directory `wrangler dev` serves and watches, and the reload that follows lands wherever the
// suite happens to have got to.
export const PREPARE_COMMANDS: readonly HarnessCommand[] = [
	{
		command: "vp",
		arguments_: ["build"],
		environment: {
			VITE_APPLICATION_VERSION: UPGRADED_APPLICATION_VERSION,
			VITE_BUILD_OUT_DIR: upgradedClientDirectory,
		},
	},
	{command: "vp", arguments_: ["build"], environment: {VITE_APPLICATION_VERSION: INITIAL_APPLICATION_VERSION}},
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
		// `log` rather than `error`, because a reload and a restart are logged at this level and
		// they are the two events a failed spec most often needs explained.
		"--log-level",
		"log",
		"--show-interactive-dev-session",
		"false",
	],
};

export const BROWSER_TEST_PREPARE_COMMAND = "node --experimental-strip-types scripts/browser-test-prepare.ts";
export const BROWSER_TEST_SERVE_COMMAND = "node --experimental-strip-types scripts/browser-test-server.ts";

export function removeTestState(): void {
	rmSync(stateDirectory, {force: true, recursive: true});
	rmSync(upgradedClientDirectory, {force: true, recursive: true});
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
		for (const {command, arguments_, environment} of PREPARE_COMMANDS) {
			const result = spawnSync(command, [...arguments_], {
				cwd: repositoryDirectory,
				env: {
					...process.env,
					CI: "true",
					VITE_APPLICATION_VERSION: INITIAL_APPLICATION_VERSION,
					...environment,
				},
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

/**
 * Put the prepared upgraded client where the server serves from, without ever letting that
 * directory stop existing.
 *
 * The server watches this tree, so the swap is a reload no matter how it is done. What it must not
 * be is a reload the server cannot survive: removing and recreating the directory can cost
 * `wrangler dev` its watch, and emptying it can hand a reload an asset manifest with nothing in it.
 * Writing over the tree in place and then deleting what the new version does not have keeps every
 * directory in the watch continuously present.
 */
export function serveUpgradedClient(): void {
	const preparedFiles = new Set(readdirSync(upgradedClientDirectory, {recursive: true, encoding: "utf8"}));
	cpSync(upgradedClientDirectory, servedClientDirectory, {force: true, recursive: true});
	for (const entry of readdirSync(servedClientDirectory, {recursive: true, encoding: "utf8"})) {
		if (!preparedFiles.has(entry)) {
			rmSync(resolve(servedClientDirectory, entry), {force: true, recursive: true});
		}
	}
}

/** Refuse to serve state that `prepareBrowserTests` never produced, rather than serving a stale build. */
export function requirePreparedBrowserTests(): void {
	const missing = [builtClientEntry, stateDirectory, environmentFile, upgradedClientDirectory].filter(
		(path) => !existsSync(path),
	);
	if (missing.length > 0) {
		throw new Error(
			`the browser test server is not prepared (missing ${missing.join(", ")}); run \`vp run test:browser\`, which runs \`${BROWSER_TEST_PREPARE_COMMAND}\` first`,
		);
	}
}
