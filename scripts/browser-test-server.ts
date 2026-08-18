import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {generateKeyPairSync, randomBytes} from "node:crypto";
import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const repositoryDirectory = resolve(import.meta.dirname, "..");
const stateDirectory = resolve(repositoryDirectory, ".llm/browser-e2e-state");
const environmentFile = resolve(repositoryDirectory, ".llm/browser-e2e.env");
const testVapidPrivateJwk = JSON.stringify(
	generateKeyPairSync("ec", {namedCurve: "P-256"}).privateKey.export({format: "jwk"}),
);

function removeTestState(): void {
	rmSync(stateDirectory, {force: true, recursive: true});
	rmSync(environmentFile, {force: true});
}

function run(command: string, arguments_: string[]): void {
	const result = spawnSync(command, arguments_, {
		cwd: repositoryDirectory,
		encoding: "utf8",
		env: {...process.env, CI: "true"},
	});
	if (result.status !== 0) {
		throw new Error(`${command} failed while preparing the browser test server`);
	}
}

function stopServer(server: ChildProcess, signal: NodeJS.Signals): void {
	server.kill(signal);
}

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

	run("vp", ["build"]);
	run("vp", [
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
	]);
} catch (error) {
	removeTestState();
	throw error;
}

const server = spawn(
	"vp",
	[
		"exec",
		"wrangler",
		"dev",
		"--config",
		"wrangler.e2e.jsonc",
		"--local",
		"--persist-to",
		stateDirectory,
		"--port",
		"4173",
		"--local-protocol",
		"https",
		"--env-file",
		environmentFile,
		"--log-level",
		"error",
		"--show-interactive-dev-session",
		"false",
	],
	{cwd: repositoryDirectory, env: {...process.env, CI: "true"}, stdio: "ignore"},
);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopping = true;
		removeTestState();
		stopServer(server, signal);
	});
}

server.on("exit", (code) => {
	removeTestState();
	process.exitCode = stopping ? 0 : (code ?? 1);
});

server.on("error", () => {
	removeTestState();
	process.exitCode = 1;
});

process.on("exit", removeTestState);
