import {hostname} from "node:os";
import {z} from "zod";

// 🤝 CLI side of pairing (spec §12): exchange a six-character code from the app for a
// machine token without persisting it, then print a ready-to-use export line.
const USAGE = "usage: yepnope-mcp pair <code> [--label <machine-label>]";
const LABEL_PREFIX = "--label=";

const claimResponseSchema = z.object({token: z.string().min(1), credential_type: z.literal("machine")});

export interface PairCommandOptions {
	baseUrl: string;
	defaultLabel?: string;
}

interface ParsedPairArguments {
	code: string;
	label: string | undefined;
}

function requireLabelValue(value: string | undefined): string {
	if (value === undefined || value === "") {
		throw new Error(`--label needs a value\n${USAGE}`);
	}
	return value;
}

function parsePairArguments(argv: string[]): ParsedPairArguments {
	const remaining = [...argv];
	let code: string | undefined;
	let label: string | undefined;
	for (;;) {
		const argument = remaining.shift();
		if (argument === undefined) {
			break;
		}
		if (argument === "--label") {
			label = requireLabelValue(remaining.shift());
		} else if (argument.startsWith(LABEL_PREFIX)) {
			label = requireLabelValue(argument.slice(LABEL_PREFIX.length));
		} else if (argument.startsWith("-")) {
			throw new Error(`unknown option ${argument}\n${USAGE}`);
		} else if (code === undefined) {
			code = argument;
		} else {
			throw new Error(`unexpected argument ${argument}\n${USAGE}`);
		}
	}
	if (code === undefined) {
		throw new Error(`missing pairing code; generate one in the app under Pair a machine\n${USAGE}`);
	}
	// The code alphabet is uppercase-only, but it gets typed by hand off a phone screen.
	return {code: code.toUpperCase(), label};
}

function pairedMessage(label: string, token: string): string {
	return (
		`Paired this machine as "${label}".\n\n` +
		`  export YEPNOPE_TOKEN=${token}\n\n` +
		"Add that line to your shell profile, or pass the token when registering the shim:\n\n" +
		`  claude mcp add yepnope --env YEPNOPE_TOKEN=${token} -- npx yepnope-mcp\n`
	);
}

export async function runPairCommand(argv: string[], options: PairCommandOptions): Promise<string> {
	const {code, label: requestedLabel} = parsePairArguments(argv);
	const label = requestedLabel ?? options.defaultLabel ?? hostname();
	const response = await fetch(new URL("/api/v1/pair/claim", options.baseUrl), {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({code, label}),
	});
	if (response.status === 404) {
		throw new Error(
			"pairing code not found or expired. Codes last ten minutes; generate a fresh one in the app and retry.",
		);
	}
	if (response.status !== 201) {
		throw new Error(`pairing failed: the server answered HTTP ${response.status}.`);
	}
	const claimed = claimResponseSchema.parse(await response.json());
	return pairedMessage(label, claimed.token);
}
