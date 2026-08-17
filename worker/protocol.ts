import {z} from "zod";
import {dispositionSchema, type Disposition} from "./validation";

// 📡 State-based socket protocol: every frame carries the full disposition set for the batch.

export type DispositionMap = Record<string, Disposition | null>;

export function stateFrame(batchId: string, dispositions: DispositionMap): string {
	return JSON.stringify({type: "state", batch_id: batchId, dispositions});
}

export function resolvedFrame(batchId: string, dispositions: DispositionMap): string {
	return JSON.stringify({type: "resolved", batch_id: batchId, dispositions});
}

export function errorFrame(batchId: string, dispositions: DispositionMap, code: string, message: string): string {
	return JSON.stringify({type: "error", batch_id: batchId, dispositions, code, message});
}

export function isComplete(dispositions: DispositionMap): boolean {
	return Object.values(dispositions).every((disposition) => disposition !== null);
}

const dispositionsSchema = z.record(z.string(), dispositionSchema.nullable());

const frameSchema = z.discriminatedUnion("type", [
	z.object({type: z.literal("state"), batch_id: z.string(), dispositions: dispositionsSchema}),
	z.object({type: z.literal("resolved"), batch_id: z.string(), dispositions: dispositionsSchema}),
	z.object({
		type: z.literal("error"),
		batch_id: z.string(),
		dispositions: dispositionsSchema,
		code: z.string(),
		message: z.string(),
	}),
]);

export type Frame = z.infer<typeof frameSchema>;

export function parseFrame(raw: string): Frame | null {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = frameSchema.safeParse(json);
	return parsed.success ? parsed.data : null;
}
