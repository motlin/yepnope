import {mkdir, writeFile} from "node:fs/promises";
import {hostname} from "node:os";
import {dirname} from "node:path";
import {z} from "zod";
import {MACHINE_TOKEN_PATTERN} from "../worker/machine-token";

// 🤝 CLI side of pairing (spec §12): exchange a six-character code from the app for a
// machine token, then hand it directly to the operator or an owner-only token file.
const USAGE = "usage: yepnope-mcp pair <code> [--label <machine-label>] [--token-file <path>]";
const LABEL_PREFIX = "--label=";
const TOKEN_FILE_PREFIX = "--token-file=";

const claimResponseSchema = z.object({
	token: z.string().regex(MACHINE_TOKEN_PATTERN),
	credential_type: z.literal("machine"),
});

type PersistMachineToken = (path: string, token: string) => Promise<void>;

export interface PairCommandOptions {
	baseUrl: string;
	defaultLabel?: string;
	persistMachineToken?: PersistMachineToken;
}

interface ParsedPairArguments {
	code: string;
	label: string | undefined;
	tokenFile: string | undefined;
}

function requireOptionValue(option: string, value: string | undefined): string {
	if (value === undefined || value === "") {
		throw new Error(`${option} needs a value\n${USAGE}`);
	}
	return value;
}

function parsePairArguments(argv: string[]): ParsedPairArguments {
	const remaining = [...argv];
	let code: string | undefined;
	let label: string | undefined;
	let tokenFile: string | undefined;
	for (;;) {
		const argument = remaining.shift();
		if (argument === undefined) {
			break;
		}
		if (argument === "--label") {
			label = requireOptionValue("--label", remaining.shift());
		} else if (argument.startsWith(LABEL_PREFIX)) {
			label = requireOptionValue("--label", argument.slice(LABEL_PREFIX.length));
		} else if (argument === "--token-file") {
			tokenFile = requireOptionValue("--token-file", remaining.shift());
		} else if (argument.startsWith(TOKEN_FILE_PREFIX)) {
			tokenFile = requireOptionValue("--token-file", argument.slice(TOKEN_FILE_PREFIX.length));
		} else if (argument.startsWith("-")) {
			throw new Error(`unknown option ${argument}\n${USAGE}`);
		} else if (code === undefined) {
			code = argument;
		} else {
			throw new Error(`unexpected argument ${argument}\n${USAGE}`);
		}
	}
	if (code === undefined) {
		throw new Error(`missing pairing code; generate one in the app under Connect a CLI\n${USAGE}`);
	}
	// The code alphabet is uppercase-only, but it gets typed by hand off a phone screen.
	return {code: code.toUpperCase(), label, tokenFile};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function persistMachineToken(path: string, token: string): Promise<void> {
	await mkdir(dirname(path), {recursive: true, mode: 0o700});
	await writeFile(path, `${token}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
}

function pairedMessage(label: string, token: string, tokenFile: string | undefined): string {
	if (tokenFile !== undefined) {
		return (
			`Paired this machine as "${label}".\n\n` +
			`Saved the one-time machine credential to ${tokenFile} with owner-only permissions.\n\n` +
			"Register the MCP server without copying the credential into shell history:\n\n" +
			`  claude mcp add yepnope --scope local --env YEPNOPE_TOKEN_FILE=${shellQuote(tokenFile)} -- npx yepnope-mcp\n`
		);
	}
	return (
		`Paired this machine as "${label}".\n\n` +
		"Machine credential (shown once; keep it out of logs and version control):\n\n" +
		`  export YEPNOPE_TOKEN=${token}\n\n` +
		"After exporting it, register the shim with `claude mcp add yepnope --scope local -- npx yepnope-mcp`.\n"
	);
}

export async function runPairCommand(argv: string[], options: PairCommandOptions): Promise<string> {
	const {code, label: requestedLabel, tokenFile} = parsePairArguments(argv);
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
	if (tokenFile !== undefined) {
		await (options.persistMachineToken ?? persistMachineToken)(tokenFile, claimed.token);
	}
	return pairedMessage(label, claimed.token, tokenFile);
}
