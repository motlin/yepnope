import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

// 🌗 The palette is the only place `src/app.css` writes a colour down, so it is the only place
// contrast can be checked once and hold everywhere. This suite reads the stylesheet itself rather
// than a copy of it: a token edited in the CSS is measured here on the next run, and a colour
// smuggled back into a rule fails the literals test below.

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/app.css"), "utf8");

const LIGHT_BLOCK = /^:root \{\n([\S\s]*?)\n\}/m;
const SYSTEM_DARK_BLOCK = /^\t:root:not\(\[data-theme="light"]\) \{\n([\S\s]*?)\n\t\}/m;
const CHOSEN_DARK_BLOCK = /^:root\[data-theme="dark"] \{\n([\S\s]*?)\n\}/m;

/** Every capture in these patterns is mandatory, so a missing one is a broken pattern, not a case. */
function group(matched: RegExpExecArray | null, index: number): string {
	const captured = matched?.[index];
	if (captured === undefined) {
		throw new Error(`capture ${index} is missing from ${String(matched?.[0])}`);
	}
	return captured;
}

function blockBody(pattern: RegExp): string {
	const matched = pattern.exec(stylesheet);
	if (matched === null) {
		throw new Error(`src/app.css has no block matching ${pattern.source}`);
	}
	return group(matched, 1);
}

function declarations(body: string): Map<string, string> {
	const parsed = new Map<string, string>();
	for (const line of body.split("\n")) {
		const declaration = /^\s*(--[a-z-]+):\s*(.+);$/.exec(line);
		if (declaration !== null) {
			parsed.set(group(declaration, 1), group(declaration, 2));
		}
	}
	return parsed;
}

const light = declarations(blockBody(LIGHT_BLOCK));
const systemDark = declarations(blockBody(SYSTEM_DARK_BLOCK));
const chosenDark = declarations(blockBody(CHOSEN_DARK_BLOCK));
const dark = new Map([...light, ...chosenDark]);

interface Color {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}

function parseColor(value: string): Color {
	const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/.exec(value);
	if (hex !== null) {
		return {
			alpha: 1,
			blue: Number.parseInt(group(hex, 3), 16),
			green: Number.parseInt(group(hex, 2), 16),
			red: Number.parseInt(group(hex, 1), 16),
		};
	}
	const functional = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/.exec(value);
	if (functional === null) {
		throw new Error(`unsupported colour syntax: ${value}`);
	}
	return {
		alpha: Number(group(functional, 4)) / 100,
		blue: Number(group(functional, 3)),
		green: Number(group(functional, 2)),
		red: Number(group(functional, 1)),
	};
}

/** Flattens a translucent colour onto the opaque one beneath it, the way the compositor would. */
function flatten(over: Color, under: Color): Color {
	return {
		alpha: 1,
		blue: over.blue * over.alpha + under.blue * (1 - over.alpha),
		green: over.green * over.alpha + under.green * (1 - over.alpha),
		red: over.red * over.alpha + under.red * (1 - over.alpha),
	};
}

function channelLuminance(channel: number): number {
	const normalized = channel / 255;
	return normalized <= 0.040_45 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: Color): number {
	return (
		0.2126 * channelLuminance(color.red) +
		0.7152 * channelLuminance(color.green) +
		0.0722 * channelLuminance(color.blue)
	);
}

function contrastRatio(foreground: Color, background: Color): number {
	const brighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
	const dimmer = Math.min(relativeLuminance(foreground), relativeLuminance(background));
	return (brighter + 0.05) / (dimmer + 0.05);
}

/** Resolves a stack written outermost-first, so `["--overlay-hover", "--surface-page"]` is a hover. */
function resolveStack(palette: Map<string, string>, stack: string[]): Color {
	return stack
		.map((token) => {
			const value = palette.get(token);
			if (value === undefined) {
				throw new Error(`no token named ${token}`);
			}
			return parseColor(value);
		})
		.reduceRight((under, over) => flatten(over, under));
}

interface ContrastRequirement {
	/** Outermost-first: a translucent first entry is flattened onto the entries behind it. */
	background: string[];
	foreground: string;
	minimum: number;
	surface: string;
}

const TEXT = 4.5;
const NON_TEXT = 3;

const REQUIREMENTS: ContrastRequirement[] = [
	{background: ["--surface-page"], foreground: "--text-strong", minimum: TEXT, surface: "deck header project"},
	{background: ["--surface-page"], foreground: "--text-body", minimum: TEXT, surface: "page body copy"},
	{background: ["--surface-page"], foreground: "--text-secondary", minimum: TEXT, surface: "AFK off label"},
	{background: ["--surface-page"], foreground: "--text-muted", minimum: TEXT, surface: "disabled AFK label"},
	{background: ["--surface-page"], foreground: "--text-faint", minimum: TEXT, surface: "deck count and gear"},
	{background: ["--surface-panel"], foreground: "--text-strong", minimum: TEXT, surface: "panel headings"},
	{background: ["--surface-panel"], foreground: "--text-body", minimum: TEXT, surface: "form labels"},
	{background: ["--surface-panel"], foreground: "--text-secondary", minimum: TEXT, surface: "panel copy"},
	{background: ["--surface-panel"], foreground: "--text-tertiary", minimum: TEXT, surface: "account links"},
	{background: ["--surface-panel"], foreground: "--text-muted", minimum: TEXT, surface: "device metadata"},
	{background: ["--surface-panel"], foreground: "--text-faint", minimum: TEXT, surface: "undo bar copy"},
	{background: ["--surface-inset"], foreground: "--text-strong", minimum: TEXT, surface: "text inputs"},
	{background: ["--surface-inset"], foreground: "--text-body", minimum: TEXT, surface: "install command label"},
	{background: ["--surface-inset"], foreground: "--text-tertiary", minimum: TEXT, surface: "OAuth capability copy"},
	{background: ["--surface-inset"], foreground: "--danger-text", minimum: TEXT, surface: "copy-blocked warning"},
	{background: ["--surface-raised"], foreground: "--text-strong", minimum: TEXT, surface: "OAuth cancel button"},
	{background: ["--surface-raised"], foreground: "--text-body", minimum: TEXT, surface: "back to the deck"},
	{background: ["--danger-surface"], foreground: "--danger-text", minimum: TEXT, surface: "form errors"},
	{background: ["--success-surface"], foreground: "--success-text", minimum: TEXT, surface: "form successes"},
	{background: ["--surface-panel"], foreground: "--success-text", minimum: TEXT, surface: "connected-client links"},
	{background: ["--yep-fill"], foreground: "--yep-on-fill", minimum: TEXT, surface: "primary buttons"},

	{background: ["--surface-page"], foreground: "--yep-ink", minimum: TEXT, surface: "Yep action"},
	{background: ["--surface-page"], foreground: "--nope-ink", minimum: TEXT, surface: "Nope action"},
	{background: ["--surface-page"], foreground: "--skip-ink", minimum: TEXT, surface: "Skip action"},
	{background: ["--overlay-hover", "--surface-page"], foreground: "--yep-ink", minimum: TEXT, surface: "Yep hover"},
	{background: ["--overlay-hover", "--surface-page"], foreground: "--nope-ink", minimum: TEXT, surface: "Nope hover"},
	{background: ["--overlay-hover", "--surface-page"], foreground: "--skip-ink", minimum: TEXT, surface: "Skip hover"},
	{background: ["--surface-panel"], foreground: "--yep-ink", minimum: TEXT, surface: "Yep recorded"},
	{background: ["--surface-panel"], foreground: "--nope-ink", minimum: TEXT, surface: "Nope recorded"},
	{background: ["--surface-panel"], foreground: "--skip-ink", minimum: TEXT, surface: "Skip recorded"},

	{
		background: ["--overlay-soft", "--surface-page"],
		foreground: "--text-secondary",
		minimum: TEXT,
		surface: "AFK off",
	},
	{
		background: ["--overlay-hover", "--surface-page"],
		foreground: "--text-strong",
		minimum: TEXT,
		surface: "AFK hover",
	},
	{
		background: ["--overlay-active", "--surface-page"],
		foreground: "--text-strong",
		minimum: TEXT,
		surface: "AFK pressed",
	},
	{
		background: ["--overlay-faint", "--surface-page"],
		foreground: "--text-muted",
		minimum: TEXT,
		surface: "AFK disabled",
	},
	{background: ["--yep-tint", "--surface-page"], foreground: "--yep-ink", minimum: TEXT, surface: "AFK on"},
	{
		background: ["--yep-tint-hover", "--surface-page"],
		foreground: "--yep-ink",
		minimum: TEXT,
		surface: "AFK on hover",
	},
	{
		background: ["--yep-tint-active", "--surface-page"],
		foreground: "--yep-ink",
		minimum: TEXT,
		surface: "AFK on pressed",
	},

	{background: ["--card-bg"], foreground: "--card-text", minimum: TEXT, surface: "card title and body"},
	{background: ["--card-chip-bg"], foreground: "--card-chip-text", minimum: TEXT, surface: "card chips"},
	{background: ["--card-code-bg"], foreground: "--card-text", minimum: TEXT, surface: "card code spans"},
	{background: ["--card-stamp-backing", "--card-bg"], foreground: "--card-yep", minimum: TEXT, surface: "YEP stamp"},
	{
		background: ["--card-stamp-backing", "--card-bg"],
		foreground: "--card-nope",
		minimum: TEXT,
		surface: "NOPE stamp",
	},
	{
		background: ["--card-stamp-backing", "--card-bg"],
		foreground: "--card-skip",
		minimum: TEXT,
		surface: "SKIP stamp",
	},

	{background: ["--surface-page"], foreground: "--border-control", minimum: NON_TEXT, surface: "status pill border"},
	{background: ["--surface-panel"], foreground: "--border-control", minimum: NON_TEXT, surface: "secondary border"},
	{background: ["--surface-inset"], foreground: "--border-control", minimum: NON_TEXT, surface: "input border"},
	{
		background: ["--surface-page"],
		foreground: "--border-control-strong",
		minimum: NON_TEXT,
		surface: "AFK off border",
	},
	{
		background: ["--surface-panel"],
		foreground: "--border-control-strong",
		minimum: NON_TEXT,
		surface: "outline button border",
	},
	{background: ["--surface-page"], foreground: "--focus-ring", minimum: NON_TEXT, surface: "focus ring on the deck"},
	{background: ["--surface-panel"], foreground: "--focus-ring", minimum: NON_TEXT, surface: "focus ring on a panel"},
	{background: ["--surface-inset"], foreground: "--focus-ring", minimum: NON_TEXT, surface: "focus ring on an input"},
];

describe("The theme palette", () => {
	it("declares the dark overrides identically for the system query and the explicit choice", () => {
		expect([...systemDark]).toStrictEqual([...chosenDark]);
	});

	it("gives every token a value on bare :root, so no colour lives only in a media or attribute block", () => {
		expect([...chosenDark.keys()].filter((token) => !light.has(token))).toStrictEqual([]);
	});

	// The palette is only a single source of truth while nothing writes a colour anywhere else.
	it("keeps every colour literal inside the palette blocks", () => {
		const rules = [LIGHT_BLOCK, SYSTEM_DARK_BLOCK, CHOSEN_DARK_BLOCK].reduce(
			(remaining, block) => remaining.replace(block, ""),
			stylesheet,
		);
		expect(rules.match(/#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/g)).toBeNull();
	});

	it.each([
		["light", light],
		["dark", dark],
	])("meets WCAG AA everywhere in %s", (_name, palette) => {
		const failures = REQUIREMENTS.map((requirement) => ({
			ratio: contrastRatio(
				resolveStack(palette, [requirement.foreground]),
				resolveStack(palette, requirement.background),
			),
			required: requirement.minimum,
			surface: requirement.surface,
			token: requirement.foreground,
		}))
			.filter((measured) => measured.ratio < measured.required)
			.map((measured) => ({...measured, ratio: Number(measured.ratio.toFixed(2))}));
		expect(failures).toStrictEqual([]);
	});
});
