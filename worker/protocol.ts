import type {Disposition} from "./validation";

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
