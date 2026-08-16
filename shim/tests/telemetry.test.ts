import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {recordAndCoach, TELEMETRY_WINDOW} from "../telemetry";

describe("yes-rate telemetry", () => {
	let directory: string;
	let path: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "yepnope-telemetry-"));
		path = join(directory, "nested", "telemetry.json");
	});

	afterEach(async () => {
		await rm(directory, {recursive: true, force: true});
	});

	it("stays silent below the minimum sample size", async () => {
		expect(await recordAndCoach(path, Array(19).fill("yep"))).toBeNull();
	});

	it("accumulates dispositions across calls on disk", async () => {
		await recordAndCoach(path, Array(10).fill("yep"));
		const coaching = await recordAndCoach(path, Array(10).fill("yep"));
		expect(coaching).toBe(
			"The user has answered yes to 100% of your last 20 questions. Ask less: act on your own " +
				"judgment unless a wrong guess would be expensive or irreversible.",
		);
		const stored = JSON.parse(await readFile(path, "utf8"));
		expect(stored).toEqual({dispositions: Array(20).fill("yep")});
	});

	it("counts a skip as an ask but not as a yep", async () => {
		const coaching = await recordAndCoach(path, [...Array(19).fill("yep"), "skip"]);
		expect(coaching).toBeNull();
	});

	it("counts a nope as an ask but not as a yep", async () => {
		const coaching = await recordAndCoach(path, [...Array(19).fill("yep"), "nope"]);
		expect(coaching).toBeNull();
	});

	it("coaches from the rolling window only", async () => {
		await recordAndCoach(path, Array(100).fill("nope"));
		const coaching = await recordAndCoach(path, Array(TELEMETRY_WINDOW).fill("yep"));
		expect(coaching).toBe(
			`The user has answered yes to 100% of your last ${TELEMETRY_WINDOW} questions. Ask less: ` +
				"act on your own judgment unless a wrong guess would be expensive or irreversible.",
		);
	});

	it("survives a corrupt telemetry file", async () => {
		await recordAndCoach(path, ["yep"]);
		const {writeFile} = await import("node:fs/promises");
		await writeFile(path, "not json");
		expect(await recordAndCoach(path, ["yep"])).toBeNull();
	});
});
