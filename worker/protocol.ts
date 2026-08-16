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

export function errorFrame(code: string, message: string): string {
	return JSON.stringify({type: "error", code, message});
}

export function isComplete(dispositions: DispositionMap): boolean {
	return Object.values(dispositions).every((disposition) => disposition !== null);
}

// 📥 The reading half of the same protocol, kept beside the writers so the wire shape is
// declared once: the hook bridge parses these frames back off a socket into the DO.
const frameSchema = z.looseObject({
	type: z.string(),
	batch_id: z.string().optional(),
	code: z.string().optional(),
	dispositions: z.record(z.string(), dispositionSchema.nullable()).optional(),
});

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
