import {spawn, type ChildProcess} from "node:child_process";
import {
	removeTestState,
	repositoryDirectory,
	requirePreparedBrowserTests,
	SERVE_COMMAND,
} from "./browser-test-harness.ts";

// 🚀 The Playwright web server. It assumes `scripts/browser-test-prepare.ts` already built the
// client and migrated the database, so all Playwright's start-up timeout has to cover is
// `wrangler dev` binding its port.

function stopServer(server: ChildProcess, signal: NodeJS.Signals): void {
	server.kill(signal);
}

requirePreparedBrowserTests();

const server = spawn(SERVE_COMMAND.command, [...SERVE_COMMAND.arguments_], {
	cwd: repositoryDirectory,
	env: {...process.env, CI: "true"},
	stdio: "ignore",
});

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
