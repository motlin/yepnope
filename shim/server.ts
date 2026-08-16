// eslint-disable-next-line typescript/no-deprecated -- the low-level Server is the sanctioned way to publish a verbatim JSON Schema tool listing
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";
import {askYepNope, type AskOptions} from "./ask";
import {deriveGitContext, type GitContext} from "./git-context";
import {recordAndCoach} from "./telemetry";
import {TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, TOOL_NAME} from "./tool";

const SHIM_VERSION = "0.1.0";

export interface ShimServerOptions {
	baseUrl: string;
	token: string;
	telemetryPath: string;
	heartbeatMilliseconds?: number;
	progressMilliseconds?: number;
	reconnectDelayMilliseconds?: number;
	deriveContext?: (directory: string) => Promise<GitContext>;
}

// 🪃 Lenient shape check only: length limits go through findLengthViolations so the model
// gets the teaching rejection (spec §7.2), never a zod stack trace.
const argumentsSchema = z.object({
	project: z.string().min(1),
	questions: z.array(z.object({title: z.string(), body: z.string()})).min(1),
});

function textResult(text: string, isError: boolean): CallToolResult {
	return {content: [{type: "text", text}], ...(isError ? {isError: true} : {})};
}

// eslint-disable-next-line typescript/no-deprecated -- see import note
export function createShimServer(options: ShimServerOptions): Server {
	// eslint-disable-next-line typescript/no-deprecated -- see import note
	const server = new Server({name: "yepnope", version: SHIM_VERSION}, {capabilities: {tools: {}}});

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [
			{
				name: TOOL_NAME,
				description: TOOL_DESCRIPTION,
				inputSchema: TOOL_INPUT_SCHEMA,
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
		if (request.params.name !== TOOL_NAME) {
			return textResult(`Unknown tool: ${request.params.name}. The only tool here is ${TOOL_NAME}.`, true);
		}
		const parsed = argumentsSchema.safeParse(request.params.arguments);
		if (!parsed.success) {
			return textResult(
				"ask_yep_nope needs a project label and a non-empty questions array of {title, body} objects.",
				true,
			);
		}

		const progressToken = extra._meta?.progressToken;
		let progressCount = 0;
		const askOptions: AskOptions = {
			baseUrl: options.baseUrl,
			token: options.token,
			signal: extra.signal,
			...(options.heartbeatMilliseconds === undefined
				? {}
				: {heartbeatMilliseconds: options.heartbeatMilliseconds}),
			...(options.progressMilliseconds === undefined ? {} : {progressMilliseconds: options.progressMilliseconds}),
			...(options.reconnectDelayMilliseconds === undefined
				? {}
				: {reconnectDelayMilliseconds: options.reconnectDelayMilliseconds}),
			// ⏲️ Progress notifications reset the harness tool timeout (spec §5); harnesses
			// without support need their timeout raised (MCP_TOOL_TIMEOUT in the README).
			...(progressToken === undefined
				? {}
				: {
						onProgress: (message: string) => {
							progressCount += 1;
							void extra
								.sendNotification({
									method: "notifications/progress",
									params: {progressToken, progress: progressCount, message},
								})
								.catch(() => undefined);
						},
					}),
		};

		const directory = process.cwd();
		const context = await (options.deriveContext ?? deriveGitContext)(directory);
		const outcome = await askYepNope(parsed.data, context, askOptions);
		if (outcome.isError) {
			return textResult(outcome.text, true);
		}
		const coaching = await recordAndCoach(options.telemetryPath, outcome.dispositions).catch(() => null);
		return textResult(coaching === null ? outcome.text : `${outcome.text}\n\n${coaching}`, false);
	});

	return server;
}
