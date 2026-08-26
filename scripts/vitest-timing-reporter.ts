import {relative} from "node:path";
import type {Reporter} from "vitest/reporters";

type TestModules = Parameters<NonNullable<Reporter["onTestRunEnd"]>>[0];

export default class VitestTimingReporter implements Reporter {
	onTestRunEnd(testModules: TestModules): void {
		const timings = testModules
			.map((testModule) => {
				const diagnostic = testModule.diagnostic();
				return {
					collectMilliseconds: diagnostic.collectDuration,
					environmentMilliseconds: diagnostic.environmentSetupDuration,
					file: relative(process.cwd(), testModule.moduleId),
					prepareMilliseconds: diagnostic.prepareDuration,
					setupMilliseconds: diagnostic.setupDuration,
					testMilliseconds: diagnostic.duration,
				};
			})
			.sort(
				(left, right) =>
					right.collectMilliseconds +
					right.environmentMilliseconds +
					right.prepareMilliseconds +
					right.setupMilliseconds +
					right.testMilliseconds -
					(left.collectMilliseconds +
						left.environmentMilliseconds +
						left.prepareMilliseconds +
						left.setupMilliseconds +
						left.testMilliseconds),
			);
		console.log(`TEST_TIMINGS=${JSON.stringify(timings)}`);
	}
}
