import {spawn} from "node:child_process";

const serverName = "yepnope-smoke";
const productionOrigin = "https://yepnope.app";
const scopes = "openid,offline_access,yepnope:questions,yepnope:afk";

function usage(): string {
	return [
		"Usage: pnpm smoke:codex-oauth -- --url https://candidate.example/mcp [--allow-production]",
		"",
		"Registers a temporary URL-based MCP server, completes Codex OAuth login, and runs one",
		"three-question ask_yep_nope smoke call. The temporary registration is removed afterward.",
	].join("\n");
}

function candidateUrl(arguments_: string[]): URL {
	if (arguments_.includes("--help")) {
		process.stdout.write(`${usage()}\n`);
		process.exit(0);
	}
	const urlIndex = arguments_.indexOf("--url");
	const value = urlIndex === -1 ? undefined : arguments_[urlIndex + 1];
	if (value === undefined) {
		throw new Error("A candidate MCP --url is required");
	}
	const candidate = new URL(value);
	if (candidate.username !== "" || candidate.password !== "" || candidate.search !== "" || candidate.hash !== "") {
		throw new Error("The candidate URL must not contain credentials, a query, or a fragment");
	}
	if (candidate.pathname !== "/mcp") {
		throw new Error("The candidate URL path must be /mcp");
	}
	const loopback =
		candidate.hostname === "127.0.0.1" || candidate.hostname === "[::1]" || candidate.hostname === "localhost";
	if (candidate.protocol !== "https:" && !(candidate.protocol === "http:" && loopback)) {
		throw new Error("The candidate URL must use HTTPS, except for an HTTP loopback server");
	}
	if (candidate.origin === productionOrigin && !arguments_.includes("--allow-production")) {
		throw new Error("Refusing the production endpoint without --allow-production");
	}
	return candidate;
}

// 🚫 The point of the smoke run is that browser OAuth carries it end to end. An inherited bearer
// token would let a broken authorization pass, so the child gets an environment with none.
function childEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("YEPNOPE_") || name === "YEPNOPE_URL"),
	);
}

async function runCodex(arguments_: string[], environment: NodeJS.ProcessEnv, silent = false): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", arguments_, {
			env: environment,
			stdio: silent ? "ignore" : "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal !== null) {
				reject(new Error(`Codex exited after signal ${signal}`));
				return;
			}
			resolve(code ?? 1);
		});
	});
}

async function requireCodex(arguments_: string[], environment: NodeJS.ProcessEnv, label: string): Promise<void> {
	if ((await runCodex(arguments_, environment)) !== 0) {
		throw new Error(`${label} failed`);
	}
}

async function main(): Promise<void> {
	const candidate = candidateUrl(process.argv.slice(2));
	const environment = childEnvironment();
	if ((await runCodex(["mcp", "get", serverName], environment, true)) === 0) {
		throw new Error(
			`Codex MCP registration ${serverName} already exists; remove or rename it before the smoke run`,
		);
	}

	let registered = false;
	try {
		await requireCodex(
			["mcp", "add", serverName, "--url", candidate.href, "--oauth-resource", candidate.href],
			environment,
			"Codex MCP registration",
		);
		registered = true;
		await requireCodex(["mcp", "login", serverName, "--scopes", scopes], environment, "Codex OAuth login");
		await requireCodex(
			[
				"exec",
				"--ephemeral",
				"--sandbox",
				"read-only",
				"--cd",
				process.cwd(),
				"Use only the yepnope-smoke MCP server. Turn AFK routing on, then call ask_yep_nope once " +
					"with exactly three harmless verification questions. Wait for one Yep, one Nope, and one Skip. " +
					"Do not repeat question text or answers in the final response; reply only SMOKE_OK after all three return.",
			],
			environment,
			"Codex OAuth MCP tool call",
		);
	} finally {
		if (registered) {
			await runCodex(["mcp", "logout", serverName], environment, true).catch(() => 1);
			const removalStatus = await runCodex(["mcp", "remove", serverName], environment, true).catch(() => 1);
			if (removalStatus !== 0) {
				throw new Error(`Could not remove temporary Codex MCP registration ${serverName}`);
			}
		}
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "Unknown Codex OAuth smoke failure";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
