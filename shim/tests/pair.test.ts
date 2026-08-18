import {mkdir, mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {join} from "node:path";
import {ZodError} from "zod";
import {persistMachineToken, runPairCommand, type PairCommandOptions} from "../pair";
import {startMockBackend, type MockBackend} from "./mock-backend";

const UNREACHED_BACKEND: PairCommandOptions = {baseUrl: "http://127.0.0.1:1", defaultLabel: "test-host"};
const MACHINE_TOKEN_FIXTURE = `ynp_live_${"A".repeat(43)}`;

describe("yepnope-mcp pair", () => {
	let backend: MockBackend | undefined;

	afterEach(async () => {
		await backend?.close();
		backend = undefined;
	});

	it("claims the code and prints the export line", async () => {
		backend = await startMockBackend({claimBody: {token: MACHINE_TOKEN_FIXTURE, credential_type: "machine"}});
		const output = await runPairCommand(["ABC234", "--label", "alice-laptop"], {baseUrl: backend.baseUrl});
		expect(backend.claimBodies).toStrictEqual([{code: "ABC234", label: "alice-laptop"}]);
		expect(output).toBe(
			'Paired this machine as "alice-laptop".\n\n' +
				"Machine credential (shown once; keep it out of logs and version control):\n\n" +
				`  export YEPNOPE_TOKEN=${MACHINE_TOKEN_FIXTURE}\n\n` +
				"After exporting it, register the shim with `claude mcp add yepnope --scope local -- npx yepnope-mcp`.\n",
		);
	});

	it("captures the one-time credential without printing it", async () => {
		backend = await startMockBackend({claimBody: {token: MACHINE_TOKEN_FIXTURE, credential_type: "machine"}});
		let persisted: {path: string; tokenMatched: boolean} | undefined;
		const output = await runPairCommand(
			["ABC234", "--label", "alice-laptop", "--token-file", "/example/config/yepnope/machine-token"],
			{
				baseUrl: backend.baseUrl,
				persistMachineToken: async (path, token) => {
					persisted = {path, tokenMatched: token === MACHINE_TOKEN_FIXTURE};
					await Promise.resolve();
				},
			},
		);

		expect({
			claimBodies: backend.claimBodies,
			output,
			outputContainsCredential: output.includes(MACHINE_TOKEN_FIXTURE),
			persisted,
		}).toStrictEqual({
			claimBodies: [{code: "ABC234", label: "alice-laptop"}],
			output:
				'Paired this machine as "alice-laptop".\n\n' +
				"Saved the one-time machine credential to /example/config/yepnope/machine-token with owner-only permissions.\n\n" +
				"Register the MCP server without copying the credential into shell history:\n\n" +
				"  claude mcp add yepnope --scope local --env YEPNOPE_TOKEN_FILE='/example/config/yepnope/machine-token' -- npx yepnope-mcp\n",
			outputContainsCredential: false,
			persisted: {path: "/example/config/yepnope/machine-token", tokenMatched: true},
		});
	});

	it("creates an exclusive owner-readable token file", async () => {
		await mkdir(".llm", {recursive: true});
		const directory = await mkdtemp(join(".llm", "pair-token-test-"));
		const path = join(directory, "machine-token");
		try {
			await persistMachineToken(path, MACHINE_TOKEN_FIXTURE);
			const metadata = await stat(path);
			const contents = await readFile(path, "utf8");
			await expect(persistMachineToken(path, MACHINE_TOKEN_FIXTURE)).rejects.toMatchObject({code: "EEXIST"});
			expect({
				contentsMatch: contents === `${MACHINE_TOKEN_FIXTURE}\n`,
				mode: metadata.mode & 0o777,
			}).toStrictEqual({
				contentsMatch: true,
				mode: 0o600,
			});
		} finally {
			await rm(directory, {recursive: true});
		}
	});

	it("uppercases the code and falls back to the default label", async () => {
		backend = await startMockBackend();
		await runPairCommand(["abc234"], {baseUrl: backend.baseUrl, defaultLabel: "test-host"});
		expect(backend.claimBodies).toStrictEqual([{code: "ABC234", label: "test-host"}]);
	});

	it("accepts --label=value", async () => {
		backend = await startMockBackend();
		await runPairCommand(["ABC234", "--label=devcontainer-3"], {baseUrl: backend.baseUrl});
		expect(backend.claimBodies).toStrictEqual([{code: "ABC234", label: "devcontainer-3"}]);
	});

	it("explains an unknown or expired code", async () => {
		backend = await startMockBackend({claimStatus: 404});
		await expect(runPairCommand(["ZZZZZZ"], {baseUrl: backend.baseUrl, defaultLabel: "test-host"})).rejects.toThrow(
			new Error(
				"pairing code not found or expired. Codes last ten minutes; generate a fresh one in the app and retry.",
			),
		);
	});

	it("reports other server errors by status", async () => {
		backend = await startMockBackend({claimStatus: 500});
		await expect(runPairCommand(["ABC234"], {baseUrl: backend.baseUrl, defaultLabel: "test-host"})).rejects.toThrow(
			new Error("pairing failed: the server answered HTTP 500."),
		);
	});

	it("rejects a response that is not explicitly a machine credential", async () => {
		backend = await startMockBackend({claimBody: {token: MACHINE_TOKEN_FIXTURE, credential_type: "legacy_app"}});
		let caught: unknown;
		try {
			await runPairCommand(["ABC234"], {baseUrl: backend.baseUrl, defaultLabel: "test-host"});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ZodError);
		if (!(caught instanceof ZodError)) {
			throw new Error("pairing accepted a non-machine credential response");
		}
		expect(caught.issues).toStrictEqual([
			{
				code: "invalid_value",
				message: 'Invalid input: expected "machine"',
				path: ["credential_type"],
				values: ["machine"],
			},
		]);
	});

	it("rejects an unprefixed machine credential response", async () => {
		backend = await startMockBackend({claimBody: {token: "A".repeat(43), credential_type: "machine"}});
		await expect(
			runPairCommand(["ABC234"], {baseUrl: backend.baseUrl, defaultLabel: "test-host"}),
		).rejects.toBeInstanceOf(ZodError);
	});

	it("requires a pairing code", async () => {
		await expect(runPairCommand([], UNREACHED_BACKEND)).rejects.toThrow(
			new Error(
				"missing pairing code; generate one in the app under Connect a CLI\n" +
					"usage: yepnope-mcp pair <code> [--label <machine-label>] [--token-file <path>]",
			),
		);
	});

	it("rejects --label without a value", async () => {
		await expect(runPairCommand(["ABC234", "--label"], UNREACHED_BACKEND)).rejects.toThrow(
			new Error(
				"--label needs a value\n" +
					"usage: yepnope-mcp pair <code> [--label <machine-label>] [--token-file <path>]",
			),
		);
	});

	it("rejects --token-file without a value", async () => {
		await expect(runPairCommand(["ABC234", "--token-file"], UNREACHED_BACKEND)).rejects.toThrow(
			new Error(
				"--token-file needs a value\n" +
					"usage: yepnope-mcp pair <code> [--label <machine-label>] [--token-file <path>]",
			),
		);
	});

	it("rejects an unknown option", async () => {
		await expect(runPairCommand(["ABC234", "--nope"], UNREACHED_BACKEND)).rejects.toThrow(
			new Error(
				"unknown option --nope\n" +
					"usage: yepnope-mcp pair <code> [--label <machine-label>] [--token-file <path>]",
			),
		);
	});
});
