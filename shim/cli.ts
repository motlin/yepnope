import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createShimServer} from "./server";
import {defaultTelemetryPath} from "./telemetry";

// 🚪 stdio entry point: `npx yepnope-mcp` with YEPNOPE_TOKEN set (README has the install block).
async function main(): Promise<void> {
	const token = process.env["YEPNOPE_TOKEN"];
	if (token === undefined || token === "") {
		process.stderr.write(
			"yepnope-mcp: YEPNOPE_TOKEN is not set. Pair a machine in the app and export the token.\n",
		);
		process.exit(1);
	}
	const server = createShimServer({
		baseUrl: process.env["YEPNOPE_URL"] ?? "https://yepnope.app",
		token,
		telemetryPath: process.env["YEPNOPE_TELEMETRY_PATH"] ?? defaultTelemetryPath(),
	});
	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
	process.stderr.write(`yepnope-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
