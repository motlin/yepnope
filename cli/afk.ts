import {z} from "zod";
import {accessToken, NotSignedInError, type CredentialStore} from "./credentials";

const USAGE = "usage: yepnope afk [status|on|off|statusline]";
const AFK_ACTIONS = ["status", "on", "off", "statusline"] as const;

const afkResponseSchema = z.object({afk: z.boolean()});
const afkConflictSchema = z.object({error: z.literal("connected_mcp_client_required"), message: z.string()});

export interface AfkDependencies {
	baseUrl: string;
	store: CredentialStore;
}

async function requestAfk(
	dependencies: AfkDependencies,
	afk: boolean | undefined,
	signal?: AbortSignal,
): Promise<Response> {
	const token = await accessToken(dependencies.baseUrl, dependencies.store);
	return fetch(new URL("/api/v1/afk", dependencies.baseUrl), {
		method: afk === undefined ? "GET" : "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			...(afk === undefined ? {} : {"Content-Type": "application/json"}),
		},
		...(signal === undefined ? {} : {signal}),
		...(afk === undefined ? {} : {body: JSON.stringify({afk})}),
	});
}

async function readAfk(dependencies: AfkDependencies, afk?: boolean): Promise<boolean> {
	const response = await requestAfk(dependencies, afk);
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
		throw new Error(`AFK request failed: the server answered HTTP ${String(response.status)}.`);
	}
	return afkResponseSchema.parse(await response.json()).afk;
}

/**
 * 🧵 A status line runs on somebody else's schedule and must never hold up a prompt, so this one has
 * a hard deadline and reports every failure as an unknown rather than raising.
 */
async function statuslineOutput(dependencies: AfkDependencies): Promise<string> {
	try {
		const response = await requestAfk(dependencies, undefined, AbortSignal.timeout(1_500));
		if (!response.ok) {
			return `⚠️ YepNope: UNKNOWN (HTTP ${String(response.status)})\n`;
		}
		return afkResponseSchema.parse(await response.json()).afk ? "📱 YepNope: ON\n" : "💻 YepNope: OFF\n";
	} catch (error) {
		return error instanceof NotSignedInError ? "⚠️ YepNope: NOT SIGNED IN\n" : "⚠️ YepNope: UNKNOWN\n";
	}
}

export async function runAfkCommand(argv: readonly string[], dependencies: AfkDependencies): Promise<string> {
	const action = argv[0] ?? "status";
	if (argv.length > 1 || !AFK_ACTIONS.some((candidate) => candidate === action)) {
		throw new Error(USAGE);
	}
	if (action === "statusline") {
		return statuslineOutput(dependencies);
	}
	if (action === "on" || action === "off") {
		return (await readAfk(dependencies, action === "on"))
			? "AFK mode is now on. New questions will route to YepNope.\n"
			: "AFK mode is now off. New questions will use native prompts.\n";
	}
	return (await readAfk(dependencies))
		? "AFK mode is on. New questions will route to YepNope.\n"
		: "AFK mode is off. New questions will use native prompts.\n";
}
