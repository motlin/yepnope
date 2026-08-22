import {spawn, type ChildProcess} from "node:child_process";
import {createWriteStream, mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {createInterface} from "node:readline";
import type {Readable} from "node:stream";
import {
	removeTestState,
	repositoryDirectory,
	requirePreparedBrowserTests,
	SERVE_COMMAND,
	SERVER_EXITED_MARKER,
	serverLogFile,
} from "./browser-test-harness.ts";

// 🚀 The Playwright web server. It assumes `scripts/browser-test-prepare.ts` already built the
// client and migrated the database, so all Playwright's start-up timeout has to cover is
// `wrangler dev` binding its port.

function stopServer(server: ChildProcess, signal: NodeJS.Signals): void {
	server.kill(signal);
}

requirePreparedBrowserTests();

// 📜 The server talks to a file rather than to nobody. A reload, a crash, or a port it could not
// bind now leaves evidence a failed spec can be read against, instead of being discarded. Every
// line is stamped, because the question a failed spec asks of this file is always "what was the
// server doing at the moment my request failed".
mkdirSync(dirname(serverLogFile), {recursive: true});
const log = createWriteStream(serverLogFile, {flags: "w"});

function recordServerOutput(output: Readable): void {
	createInterface({input: output, crlfDelay: Number.POSITIVE_INFINITY}).on("line", (line) => {
		log.write(`${new Date().toISOString()} ${line}\n`);
	});
}

const server = spawn(SERVE_COMMAND.command, [...SERVE_COMMAND.arguments_], {
	cwd: repositoryDirectory,
	env: {...process.env, CI: "true"},
	stdio: ["ignore", "pipe", "pipe"],
});
recordServerOutput(server.stdout);
recordServerOutput(server.stderr);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopping = true;
		removeTestState();
		stopServer(server, signal);
	});
}

server.on("exit", (code) => {
	if (!stopping) {
		log.write(`${new Date().toISOString()} ${SERVER_EXITED_MARKER} (exit code ${String(code)})\n`);
	}
	removeTestState();
	process.exitCode = stopping ? 0 : (code ?? 1);
});

server.on("error", () => {
	removeTestState();
	process.exitCode = 1;
});

process.on("exit", removeTestState);
