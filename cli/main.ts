import {hostname} from "node:os";
import {runAfkCommand} from "./afk";
import {credentialStore} from "./credentials";
import {runHookCommand} from "./hook";
import {runLoginCommand, runLogoutCommand} from "./login";

const DEFAULT_BASE_URL = "https://yepnope.app";

const USAGE = `usage: yepnope <command>

  login       authorize this machine in a browser
  logout      revoke and forget this machine's authorization
  hook        answer one Claude Code hook event, reading its JSON on stdin
  afk         show or change whether questions route to the phone

YEPNOPE_URL overrides the service origin for development.
`;

async function readStdin(): Promise<string> {
	process.stdin.setEncoding("utf8");
	let payload = "";
	for await (const chunk of process.stdin) {
		payload += String(chunk);
	}
	return payload;
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const baseUrl = process.env["YEPNOPE_URL"] ?? DEFAULT_BASE_URL;
	const store = credentialStore(baseUrl);
	switch (command ?? "help") {
		case "login": {
			await runLoginCommand({
				baseUrl,
				clientName: `YepNope hook on ${hostname()}`,
				sleep,
				store,
				write: (text) => process.stdout.write(text),
			});
			return;
		}
		case "logout": {
			process.stdout.write(await runLogoutCommand(baseUrl, store));
			return;
		}
		case "hook": {
			process.stdout.write(
				await runHookCommand(await readStdin(), {
					baseUrl,
					store,
					writeError: (text) => process.stderr.write(text),
				}),
			);
			return;
		}
		case "afk": {
			process.stdout.write(await runAfkCommand(rest, {baseUrl, store}));
			return;
		}
		default: {
			process.stderr.write(USAGE);
			process.exit(command === undefined || command === "help" ? 0 : 1);
		}
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`yepnope: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
