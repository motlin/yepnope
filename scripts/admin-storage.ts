import {pathToFileURL} from "node:url";
import {z} from "zod";

const objectIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const namespaceObjectSchema = z.object({id: objectIdSchema, hasStoredData: z.boolean()});
const namespacePageSchema = z.object({
	success: z.literal(true),
	result: z.array(namespaceObjectSchema),
	result_info: z.object({cursor: z.string().nullable().optional()}),
});
const tableCountSchema = z.object({name: z.string(), rows: z.number().int().nonnegative()}).strict();
const inventoryContextSchema = z
	.object({
		d1: z.object({table_counts: z.array(tableCountSchema)}).strict(),
		live_owner_object_ids: z.array(objectIdSchema),
	})
	.strict();
const objectDiagnosticsSchema = z
	.object({
		object_id: objectIdSchema,
		alarm_set: z.boolean(),
		table_counts: z.array(tableCountSchema),
	})
	.strict();
const diagnosticsResponseSchema = z.object({objects: z.array(objectDiagnosticsSchema)}).strict();
const deletionResponseSchema = z.object({object_id: objectIdSchema, status: z.literal("deleted")}).strict();
const environmentSchema = z.object({
	CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
	CLOUDFLARE_API_TOKEN: z.string().min(1),
	YEPNOPE_DO_NAMESPACE_ID: z.string().min(1),
	YEPNOPE_ADMIN_URL: z.url(),
	CF_ACCESS_CLIENT_ID: z.string().min(1),
	CF_ACCESS_CLIENT_SECRET: z.string().min(1),
});

export type StorageAdminEnvironment = z.infer<typeof environmentSchema>;

export interface StorageAdminDependencies {
	fetch: typeof fetch;
	write: (value: unknown) => void;
}

interface CleanupOptions {
	confirm: boolean;
	expectedCount: number | undefined;
}

export interface NamespaceObject {
	id: string;
	hasStoredData: boolean;
}

function parseEnvironment(environment: NodeJS.ProcessEnv): StorageAdminEnvironment {
	return environmentSchema.parse(environment);
}

async function responseJson(response: Response): Promise<unknown> {
	if (!response.ok) {
		throw new Error(`request failed with HTTP ${response.status}`);
	}
	return response.json();
}

export async function listNamespaceObjects(
	environment: StorageAdminEnvironment,
	request: typeof fetch,
): Promise<NamespaceObject[]> {
	const objects: NamespaceObject[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	do {
		const url = new URL(
			`/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/workers/durable_objects/` +
				`namespaces/${environment.YEPNOPE_DO_NAMESPACE_ID}/objects`,
			"https://api.cloudflare.com",
		);
		url.searchParams.set("limit", "1000");
		if (cursor !== undefined) {
			url.searchParams.set("cursor", cursor);
		}
		const response = await request(url, {
			headers: {Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`},
		});
		const page = namespacePageSchema.parse(await responseJson(response));
		objects.push(...page.result);
		const nextCursor = page.result_info.cursor;
		if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
			cursor = undefined;
			continue;
		}
		if (seenCursors.has(nextCursor)) {
			throw new Error("Cloudflare repeated a namespace inventory cursor");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	} while (cursor !== undefined);
	objects.sort((left, right) => left.id.localeCompare(right.id));
	const seenObjectIds = new Set<string>();
	for (const current of objects) {
		if (seenObjectIds.has(current.id)) {
			throw new Error(`Cloudflare returned duplicate known object ID ${current.id}`);
		}
		seenObjectIds.add(current.id);
	}
	return objects;
}

async function adminRequest(
	environment: StorageAdminEnvironment,
	request: typeof fetch,
	path: string,
	method: "GET" | "POST",
	body?: unknown,
): Promise<unknown> {
	const headers = new Headers({
		"CF-Access-Client-Id": environment.CF_ACCESS_CLIENT_ID,
		"CF-Access-Client-Secret": environment.CF_ACCESS_CLIENT_SECRET,
	});
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const response = await request(new URL(path, environment.YEPNOPE_ADMIN_URL), {
		method,
		headers,
		...(body === undefined ? {} : {body: JSON.stringify(body)}),
	});
	return responseJson(response);
}

async function getInventoryContext(environment: StorageAdminEnvironment, request: typeof fetch) {
	return inventoryContextSchema.parse(await adminRequest(environment, request, "/v1/inventory-context", "GET"));
}

async function getObjectDiagnostics(environment: StorageAdminEnvironment, request: typeof fetch, objectIds: string[]) {
	const objects: z.infer<typeof objectDiagnosticsSchema>[] = [];
	for (let index = 0; index < objectIds.length; index += 50) {
		const batch = objectIds.slice(index, index + 50);
		const response = diagnosticsResponseSchema.parse(
			await adminRequest(environment, request, "/v1/objects/diagnostics", "POST", {object_ids: batch}),
		);
		objects.push(...response.objects);
	}
	return objects;
}

function storedObjectIds(inventory: NamespaceObject[]): string[] {
	return inventory.filter(({hasStoredData}) => hasStoredData).map(({id}) => id);
}

function knownEmptyObjectIds(inventory: NamespaceObject[]): string[] {
	return inventory.filter(({hasStoredData}) => !hasStoredData).map(({id}) => id);
}

function orphanStoredObjectIds(inventory: NamespaceObject[], liveOwnerObjectIds: string[]): string[] {
	const owners = new Set(liveOwnerObjectIds);
	return storedObjectIds(inventory).filter((id) => !owners.has(id));
}

function inventorySignature(inventory: NamespaceObject[], liveOwnerObjectIds: string[]): string {
	return JSON.stringify({
		inventory: inventory.map(({id, hasStoredData}) => ({has_stored_data: hasStoredData, id})),
		live_owner_object_ids: [...liveOwnerObjectIds].sort(),
	});
}

async function verifyDeallocation(
	environment: StorageAdminEnvironment,
	dependencies: StorageAdminDependencies,
	objectIds: string[],
	initialInventory: NamespaceObject[],
): Promise<NamespaceObject[]> {
	const remaining = new Set(objectIds);
	const consecutiveEmptyInventories = new Map(objectIds.map((objectId) => [objectId, 0]));
	let latestInventory = initialInventory;
	for (let attempt = 0; attempt < 60 && remaining.size > 0; attempt += 1) {
		latestInventory = await listNamespaceObjects(environment, dependencies.fetch);
		for (const objectId of [...remaining]) {
			if (latestInventory.find(({id}) => id === objectId)?.hasStoredData === true) {
				consecutiveEmptyInventories.set(objectId, 0);
				continue;
			}
			const confirmations = (consecutiveEmptyInventories.get(objectId) ?? 0) + 1;
			consecutiveEmptyInventories.set(objectId, confirmations);
			if (confirmations === 3) {
				remaining.delete(objectId);
				dependencies.write({object_id: objectId, status: "verified_deallocated"});
			}
		}
		if (remaining.size > 0) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 250);
			});
		}
	}
	if (remaining.size > 0) {
		throw new Error(`${remaining.size} known object IDs still have stored data after deletion`);
	}
	return latestInventory;
}

function parseCleanupOptions(arguments_: string[]): CleanupOptions {
	let confirm = false;
	let expectedCount: number | undefined;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--confirm") {
			if (confirm) {
				throw new Error("--confirm may be specified only once");
			}
			confirm = true;
			continue;
		}
		if (argument === "--expected-count") {
			const value = arguments_.at(index + 1);
			if (expectedCount !== undefined) {
				throw new Error("--expected-count may be specified only once");
			}
			if (value === undefined || !/^\d+$/.test(value)) {
				throw new Error("--expected-count requires a non-negative integer");
			}
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed)) {
				throw new Error("--expected-count requires a non-negative integer");
			}
			expectedCount = parsed;
			index += 1;
			continue;
		}
		throw new Error(`unknown cleanup argument: ${argument}`);
	}
	if (confirm && expectedCount === undefined) {
		throw new Error("--confirm requires --expected-count");
	}
	if (!confirm && expectedCount !== undefined) {
		throw new Error("--expected-count is valid only with --confirm");
	}
	return {confirm, expectedCount};
}

async function diagnostics(
	environment: StorageAdminEnvironment,
	dependencies: StorageAdminDependencies,
): Promise<unknown> {
	const [inventory, context] = await Promise.all([
		listNamespaceObjects(environment, dependencies.fetch),
		getInventoryContext(environment, dependencies.fetch),
	]);
	const storedObjectIdentifiers = storedObjectIds(inventory);
	const objectDiagnostics = await getObjectDiagnostics(environment, dependencies.fetch, storedObjectIdentifiers);
	return {
		mode: "diagnostics",
		d1: context.d1,
		stored_object_count: storedObjectIdentifiers.length,
		stored_objects: objectDiagnostics,
		orphan_stored_object_ids: orphanStoredObjectIds(inventory, context.live_owner_object_ids),
		known_empty_object_ids: knownEmptyObjectIds(inventory),
		known_object_ids: inventory.map(({id}) => id),
	};
}

async function cleanup(
	environment: StorageAdminEnvironment,
	dependencies: StorageAdminDependencies,
	options: CleanupOptions,
): Promise<unknown> {
	const initialInventory = await listNamespaceObjects(environment, dependencies.fetch);
	const initialContext = await getInventoryContext(environment, dependencies.fetch);
	const initialStoredObjectIdentifiers = storedObjectIds(initialInventory);
	const initialOrphans = orphanStoredObjectIds(initialInventory, initialContext.live_owner_object_ids);
	if (!options.confirm) {
		return {
			mode: "dry-run",
			stored_object_count: initialStoredObjectIdentifiers.length,
			orphan_stored_object_count: initialOrphans.length,
			orphan_stored_object_ids: initialOrphans,
			known_empty_object_ids: knownEmptyObjectIds(initialInventory),
		};
	}
	if (options.expectedCount !== initialOrphans.length) {
		throw new Error(
			`expected ${options.expectedCount} orphan object IDs with stored data, found ${initialOrphans.length}`,
		);
	}

	const confirmedInventory = await listNamespaceObjects(environment, dependencies.fetch);
	const confirmedContext = await getInventoryContext(environment, dependencies.fetch);
	if (
		inventorySignature(initialInventory, initialContext.live_owner_object_ids) !==
		inventorySignature(confirmedInventory, confirmedContext.live_owner_object_ids)
	) {
		throw new Error("known object IDs, stored-data state, or live owners changed after confirmation");
	}
	const confirmedOrphans = orphanStoredObjectIds(confirmedInventory, confirmedContext.live_owner_object_ids);
	if (confirmedOrphans.length !== options.expectedCount) {
		throw new Error("orphan stored-object count changed after confirmation");
	}

	const deletedObjectIds: string[] = [];
	let deletionFailure: Error | undefined;
	try {
		for (const objectId of confirmedOrphans) {
			const deletion = deletionResponseSchema.parse(
				await adminRequest(environment, dependencies.fetch, "/v1/objects/delete", "POST", {
					object_id: objectId,
				}),
			);
			deletedObjectIds.push(deletion.object_id);
		}
	} catch (error) {
		deletionFailure = error instanceof Error ? error : new Error("Durable Object deletion failed", {cause: error});
	}
	const verifiedInventory = await verifyDeallocation(environment, dependencies, deletedObjectIds, confirmedInventory);
	if (deletionFailure !== undefined) {
		throw deletionFailure;
	}
	return {
		deleted_stored_object_count: confirmedOrphans.length,
		known_empty_object_ids: knownEmptyObjectIds(verifiedInventory),
		mode: "confirmed",
		remaining_stored_object_count: storedObjectIds(verifiedInventory).length,
		status: "complete",
	};
}

export async function runStorageAdministration(
	arguments_: string[],
	environment: StorageAdminEnvironment,
	dependencies: StorageAdminDependencies,
): Promise<unknown> {
	const command = arguments_[0] ?? "diagnostics";
	if (command === "diagnostics") {
		if (arguments_.length !== 1 && arguments_.length !== 0) {
			throw new Error("diagnostics accepts no arguments");
		}
		return diagnostics(environment, dependencies);
	}
	if (command === "cleanup") {
		return cleanup(environment, dependencies, parseCleanupOptions(arguments_.slice(1)));
	}
	throw new Error(`unknown command: ${command}`);
}

async function main(): Promise<void> {
	const environment = parseEnvironment(process.env);
	const result = await runStorageAdministration(process.argv.slice(2), environment, {
		fetch,
		write: (value) => {
			console.log(JSON.stringify(value));
		},
	});
	console.log(JSON.stringify(result, null, 2));
}

const entryPath = process.argv.at(1);
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	await main();
}
