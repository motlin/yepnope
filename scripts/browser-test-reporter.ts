import {readFile} from "node:fs/promises";
import type {FullResult, Reporter, TestCase, TestResult} from "playwright/types/testReporter";
import {SERVER_EXITED_MARKER, serverLogFile} from "./browser-test-harness.ts";

/** How much of the server's own account to reprint. Enough to reach the reason it gave for dying. */
const TAIL_LINES = 25;

/**
 * Tells a dead server apart from a broken product.
 *
 * Playwright stops watching the web server once it has answered its first request, so a
 * `wrangler dev` that dies mid-run is invisible to it: every remaining spec fails on a refused
 * connection, and the run reads as dozens of regressions. That ambiguity is what makes the suite
 * untrustworthy as a gate, because the one thing a gate has to be able to say is whether the code
 * or the machine is at fault.
 *
 * So this reads the server's own log. If the server exited on its own, the run says so in those
 * words and fails for that reason, rather than for the specs that were only ever collateral.
 */
export default class BrowserTestServerReporter implements Reporter {
	#announced = false;

	onTestEnd(_test: TestCase, result: TestResult): void {
		if (result.status === "failed" && !this.#announced) {
			void this.#announceServerExit();
		}
	}

	async onEnd(result: FullResult): Promise<{status?: FullResult["status"]} | undefined> {
		if (!(await this.#announceServerExit())) {
			return undefined;
		}
		// A run whose server died proves nothing about the code, so it must not be allowed to pass.
		return {status: result.status === "passed" ? "failed" : result.status};
	}

	/** Report the server's exit if it had one, and say whether there was one to report. */
	async #announceServerExit(): Promise<boolean> {
		const report = await this.#serverExitReport();
		if (report === null) {
			return false;
		}
		if (!this.#announced) {
			this.#announced = true;
			process.stderr.write(`\n${report}\n`);
		}
		return true;
	}

	/** The server's own last words, or null if it was still running when the run ended. */
	async #serverExitReport(): Promise<string | null> {
		let lines: string[];
		try {
			lines = (await readFile(serverLogFile, "utf8")).split("\n").filter((line) => line.length > 0);
		} catch {
			return null;
		}
		if (!lines.some((line) => line.includes(SERVER_EXITED_MARKER))) {
			return null;
		}
		return [
			`✘ ${SERVER_EXITED_MARKER}. Every spec after that point failed on a refused connection`,
			"  rather than on anything it was testing. Judge this run on the server, not on the specs.",
			`  The server's last ${String(TAIL_LINES)} lines, from ${serverLogFile}:`,
			...lines.slice(-TAIL_LINES).map((line) => `  | ${line}`),
		].join("\n");
	}
}
