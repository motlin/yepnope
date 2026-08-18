import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {readFile} from "node:fs/promises";
import {runAfkCommand} from "./afk";
import {runPairCommand} from "./pair";
import {createShimServer} from "./server";
import {defaultTelemetryPath} from "./telemetry";

const DEFAULT_BASE_URL = "https://yepnope.app";

async function configuredMachineToken(): Promise<string | undefined> {
	const environmentToken = process.env["YEPNOPE_TOKEN"];
	const tokenFile = process.env["YEPNOPE_TOKEN_FILE"];
	if (environmentToken !== undefined && tokenFile !== undefined) {
		throw new Error("set only one of YEPNOPE_TOKEN and YEPNOPE_TOKEN_FILE");
	}
	if (tokenFile === undefined) {
		return environmentToken;
	}
	const contents = await readFile(tokenFile, "utf8");
	const token = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
	if (token === "" || token.includes("\n") || token.includes("\r")) {
		throw new Error("YEPNOPE_TOKEN_FILE must contain one machine credential");
	}
	return token;
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const baseUrl = process.env["YEPNOPE_URL"] ?? DEFAULT_BASE_URL;
	if (command === "pair") {
		process.stdout.write(await runPairCommand(rest, {baseUrl}));
		return;
	}
	if (command === "afk") {
		const token = await configuredMachineToken();
		process.stdout.write(await runAfkCommand(rest, {baseUrl, ...(token === undefined ? {} : {token})}));
		return;
	}
	const token = await configuredMachineToken();
	if (token === undefined || token === "") {
		process.stderr.write(
			"yepnope-mcp: Neither YEPNOPE_TOKEN nor YEPNOPE_TOKEN_FILE is set. " +
				"Generate a pairing code in the app, then run `npx yepnope-mcp pair <code>` " +
				"or use its --token-file option.\n",
		);
		process.exit(1);
	}
	const server = createShimServer({
		baseUrl,
		token,
		telemetryPath: process.env["YEPNOPE_TELEMETRY_PATH"] ?? defaultTelemetryPath(),
	});
	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
	process.stderr.write(`yepnope-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
