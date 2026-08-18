import {z} from "zod";

const USAGE = "usage: yepnope-mcp afk [status|on|off|statusline]";
const MISSING_TOKEN_MESSAGE =
	"Neither YEPNOPE_TOKEN nor YEPNOPE_TOKEN_FILE is set. Generate a pairing code in the app, then run " +
	"`npx yepnope-mcp pair <code>` or use its --token-file option.";

const afkResponseSchema = z.object({afk: z.boolean()});
const afkConflictSchema = z.object({error: z.literal("pairing_required"), message: z.string()});

export interface AfkCommandOptions {
	baseUrl: string;
	token?: string;
}

interface AfkRequestOptions {
	baseUrl: string;
	token: string;
	afk?: boolean;
	signal?: AbortSignal;
}

async function requestAfk(options: AfkRequestOptions): Promise<Response> {
	const {baseUrl, token, afk, signal} = options;
	const headers: Record<string, string> = {Authorization: `Bearer ${token}`};
	if (afk !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	return fetch(new URL("/api/v1/afk", baseUrl), {
		method: afk === undefined ? "GET" : "PUT",
		headers,
		...(signal === undefined ? {} : {signal}),
		...(afk === undefined ? {} : {body: JSON.stringify({afk})}),
	});
}

async function readAfk(baseUrl: string, token: string, afk?: boolean): Promise<boolean> {
	const response = await requestAfk({baseUrl, token, ...(afk === undefined ? {} : {afk})});
	if (!response.ok) {
		const conflict = afkConflictSchema.safeParse(
			await response
				.clone()
				.json()
				.catch(() => null),
		);
		if (response.status === 409 && conflict.success) {
			throw new Error(conflict.data.message);
		}
		throw new Error(`AFK request failed: the server answered HTTP ${response.status}.`);
	}
	return afkResponseSchema.parse(await response.json()).afk;
}

async function statuslineOutput(options: AfkCommandOptions): Promise<string> {
	if (options.token === undefined || options.token === "") {
		return "⚠️ YepNope: TOKEN MISSING\n";
	}
	try {
		const response = await requestAfk({
			baseUrl: options.baseUrl,
			token: options.token,
			signal: AbortSignal.timeout(1_500),
		});
		if (!response.ok) {
			return `⚠️ YepNope: UNKNOWN (HTTP ${response.status})\n`;
		}
		const {afk} = afkResponseSchema.parse(await response.json());
		return afk ? "📱 YepNope: ON\n" : "💻 YepNope: OFF\n";
	} catch {
		return "⚠️ YepNope: UNKNOWN\n";
	}
}

export async function runAfkCommand(argv: string[], options: AfkCommandOptions): Promise<string> {
	const action = argv[0] ?? "status";
	if (argv.length > 1 || !["status", "on", "off", "statusline"].includes(action)) {
		throw new Error(USAGE);
	}
	if (action === "statusline") {
		return statuslineOutput(options);
	}
	if (options.token === undefined || options.token === "") {
		throw new Error(MISSING_TOKEN_MESSAGE);
	}
	if (action === "on" || action === "off") {
		const afk = await readAfk(options.baseUrl, options.token, action === "on");
		return afk
			? "AFK mode is now on. New questions will route to YepNope.\n"
			: "AFK mode is now off. New questions will use native prompts.\n";
	}
	const afk = await readAfk(options.baseUrl, options.token);
	return afk
		? "AFK mode is on. New questions will route to YepNope.\n"
		: "AFK mode is off. New questions will use native prompts.\n";
}
