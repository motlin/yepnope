import {z} from "zod";
import {BODY_MAX_CHARACTERS, TITLE_MAX_CHARACTERS} from "./validation";

// 🃏 Hook-sourced cards are server-generated, so over-length input is truncated here rather
// than rejected: there is no model in the loop to teach (spec §10 vs §7.2).

export interface PermissionCard {
	project: string;
	title: string;
	body: string;
}

// 📐 Half the body is reserved for the preamble, so an absurd tool name or description can
// never squeeze the command itself off the card.
const PREAMBLE_MAX_CHARACTERS = BODY_MAX_CHARACTERS / 2;
const DESCRIPTION_MAX_CHARACTERS = 200;
const FENCE_CHARACTERS = "\n\n```\n\n```".length;

// 👀 The fields worth surfacing on a card, when present: Bash's command, file tools' path,
// and Bash's human-readable description.
const salientInputSchema = z.looseObject({
	command: z.string().optional(),
	file_path: z.string().optional(),
	description: z.string().optional(),
});

type SalientFields = z.infer<typeof salientInputSchema>;

function truncateCharacters(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) {
		return text;
	}
	return `${text.slice(0, maxCharacters - 1)}…`;
}

function salientFields(toolInput: unknown): SalientFields {
	const parsed = salientInputSchema.safeParse(toolInput);
	return parsed.success ? parsed.data : {};
}

function salientDetail(fields: SalientFields, toolInput: unknown): string {
	const named = fields.command ?? fields.file_path;
	if (named !== undefined) {
		return named;
	}
	if (toolInput === undefined) {
		return "";
	}
	const serialized = JSON.stringify(toolInput);
	return serialized === "{}" ? "" : serialized;
}

function projectLabel(cwd: string | undefined): string {
	const basename = cwd
		?.split("/")
		.filter((segment) => segment !== "")
		.at(-1);
	return basename ?? "permission";
}

function buildTitle(toolName: string, detail: string): string {
	const firstLine = detail.split("\n", 1)[0] ?? "";
	const title = firstLine === "" ? `Allow ${toolName}?` : `Allow ${toolName}: ${firstLine}?`;
	return truncateCharacters(title, TITLE_MAX_CHARACTERS);
}

function buildBody(toolName: string, description: string | undefined, detail: string): string {
	const preamble = truncateCharacters(
		[
			`Claude Code is waiting on a **permission** prompt for the \`${toolName}\` tool.`,
			...(description === undefined ? [] : [truncateCharacters(description, DESCRIPTION_MAX_CHARACTERS)]),
		].join("\n\n"),
		PREAMBLE_MAX_CHARACTERS,
	);
	if (detail === "") {
		return preamble;
	}
	const detailBudget = BODY_MAX_CHARACTERS - preamble.length - FENCE_CHARACTERS;
	return `${preamble}\n\n\`\`\`\n${truncateCharacters(detail, detailBudget)}\n\`\`\``;
}

export function buildPermissionCard(toolName: string, toolInput: unknown, cwd: string | undefined): PermissionCard {
	const fields = salientFields(toolInput);
	const detail = salientDetail(fields, toolInput);
	return {
		project: projectLabel(cwd),
		title: buildTitle(toolName, detail),
		body: buildBody(toolName, fields.description, detail),
	};
}
