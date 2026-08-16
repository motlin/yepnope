import {mkdir, readFile, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {z} from "zod";
import {dispositionSchema, type Disposition} from "../worker/validation";

// 📈 Yes-rate telemetry lives in the shim on local disk, not on the server (spec §9):
// over-asking is a property of the model, and the shim is installed once per harness.
export const TELEMETRY_WINDOW = 500;
const COACHING_MINIMUM_ASKS = 20;
const COACHING_YEP_RATE = 0.95;

const telemetryFileSchema = z.object({dispositions: z.array(dispositionSchema)});

export function defaultTelemetryPath(): string {
	return join(homedir(), ".yepnope", "telemetry.json");
}

async function readDispositions(path: string): Promise<Disposition[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return [];
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return [];
	}
	const parsed = telemetryFileSchema.safeParse(json);
	return parsed.success ? parsed.data.dispositions : [];
}

// 🎓 Records this batch and returns the coaching line when the rolling yep rate is above
// threshold. Skips count as asks and not as yeps; excluding them would reward skipping.
export async function recordAndCoach(path: string, batch: Disposition[]): Promise<string | null> {
	const dispositions = [...(await readDispositions(path)), ...batch].slice(-TELEMETRY_WINDOW);
	await mkdir(dirname(path), {recursive: true});
	await writeFile(path, JSON.stringify({dispositions}));
	const asks = dispositions.length;
	if (asks < COACHING_MINIMUM_ASKS) {
		return null;
	}
	const yeps = dispositions.filter((disposition) => disposition === "yep").length;
	const yepRate = yeps / asks;
	if (yepRate <= COACHING_YEP_RATE) {
		return null;
	}
	const percent = Math.round(yepRate * 100);
	return (
		`The user has answered yes to ${percent}% of your last ${asks} questions. Ask less: ` +
		"act on your own judgment unless a wrong guess would be expensive or irreversible."
	);
}
