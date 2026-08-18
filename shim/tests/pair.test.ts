import {ZodError} from "zod";
import {runPairCommand, type PairCommandOptions} from "../pair";
import {startMockBackend, type MockBackend} from "./mock-backend";

const UNREACHED_BACKEND: PairCommandOptions = {baseUrl: "http://127.0.0.1:1", defaultLabel: "test-host"};

describe("yepnope-mcp pair", () => {
	let backend: MockBackend | undefined;

	afterEach(async () => {
		await backend?.close();
		backend = undefined;
	});

	it("claims the code and prints the export line", async () => {
		backend = await startMockBackend({claimBody: {token: "test-machine-token", credential_type: "machine"}});
		const output = await runPairCommand(["ABC234", "--label", "alice-laptop"], {baseUrl: backend.baseUrl});
		expect(backend.claimBodies).toStrictEqual([{code: "ABC234", label: "alice-laptop"}]);
		expect(output).toBe(
			'Paired this machine as "alice-laptop".\n\n' +
				"  export YEPNOPE_TOKEN=test-machine-token\n\n" +
				"Add that line to your shell profile, or pass the token when registering the shim:\n\n" +
				"  claude mcp add yepnope --env YEPNOPE_TOKEN=test-machine-token -- npx yepnope-mcp\n",
		);
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
		backend = await startMockBackend({claimBody: {token: "legacy-app-token", credential_type: "legacy_app"}});
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

	it("requires a pairing code", async () => {
		await expect(runPairCommand([], UNREACHED_BACKEND)).rejects.toThrow(
			new Error(
				"missing pairing code; generate one in the app under Connect a CLI\n" +
					"usage: yepnope-mcp pair <code> [--label <machine-label>]",
			),
		);
	});

	it("rejects --label without a value", async () => {
		await expect(runPairCommand(["ABC234", "--label"], UNREACHED_BACKEND)).rejects.toThrow(
			new Error("--label needs a value\nusage: yepnope-mcp pair <code> [--label <machine-label>]"),
		);
	});

	it("rejects an unknown option", async () => {
		await expect(runPairCommand(["ABC234", "--nope"], UNREACHED_BACKEND)).rejects.toThrow(
			new Error("unknown option --nope\nusage: yepnope-mcp pair <code> [--label <machine-label>]"),
		);
	});
});
