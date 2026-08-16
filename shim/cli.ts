import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {runPairCommand} from "./pair";
import {createShimServer} from "./server";
import {defaultTelemetryPath} from "./telemetry";

const DEFAULT_BASE_URL = "https://yepnope.app";

// 🚪 stdio entry point: `npx yepnope-mcp` with YEPNOPE_TOKEN set (README has the install
// block), plus `npx yepnope-mcp pair <code>` to obtain that token in the first place.
async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const baseUrl = process.env["YEPNOPE_URL"] ?? DEFAULT_BASE_URL;
	if (command === "pair") {
		process.stdout.write(await runPairCommand(rest, {baseUrl}));
		return;
	}
	const token = process.env["YEPNOPE_TOKEN"];
	if (token === undefined || token === "") {
		process.stderr.write(
			"yepnope-mcp: YEPNOPE_TOKEN is not set. Generate a pairing code in the app, then run " +
				"`npx yepnope-mcp pair <code>` and export the token it prints.\n",
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
