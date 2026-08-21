import {describe, expect, it} from "vitest";
import {
	DEPLOYMENT_ORIGIN_VARIABLE,
	DEPLOYMENT_PASSKEY_VARIABLE,
	DEPLOYMENT_PRODUCTION_OVERRIDE_VARIABLE,
	encodeAutomationPasskey,
	resolveDeploymentTarget,
	type AutomationPasskey,
} from "../scripts/deployment-check";

const PASSKEY: AutomationPasskey = {
	credentialId: "Y3JlZGVudGlhbC1pZA",
	privateKey: "cHJpdmF0ZS1rZXk",
	rpId: "yepnope-staging.example.workers.dev",
	signCount: 0,
	userHandle: "dXNlci1oYW5kbGU",
};

const ORIGIN = "https://yepnope-staging.example.workers.dev";

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		[DEPLOYMENT_ORIGIN_VARIABLE]: ORIGIN,
		[DEPLOYMENT_PASSKEY_VARIABLE]: encodeAutomationPasskey(PASSKEY),
		...overrides,
	};
}

describe("the deployed core-loop check target", () => {
	it("resolves the origin and the automation passkey it will sign in with", () => {
		expect(resolveDeploymentTarget(environment())).toStrictEqual({origin: ORIGIN, passkey: PASSKEY});
	});

	it("keeps a port in the origin and drops a trailing slash", () => {
		const passkey = {...PASSKEY, rpId: "localhost"};
		expect(
			resolveDeploymentTarget({
				[DEPLOYMENT_ORIGIN_VARIABLE]: "https://localhost:8788/",
				[DEPLOYMENT_PASSKEY_VARIABLE]: encodeAutomationPasskey(passkey),
			}),
		).toStrictEqual({origin: "https://localhost:8788", passkey});
	});

	it("names the variable and the recipe when no deployment was named", () => {
		expect(() => resolveDeploymentTarget(environment({[DEPLOYMENT_ORIGIN_VARIABLE]: undefined}))).toThrow(
			`${DEPLOYMENT_ORIGIN_VARIABLE} is not set, so there is no deployment to prove the core loop against`,
		);
	});

	it("refuses a deployment that is not reached over HTTPS", () => {
		expect(() =>
			resolveDeploymentTarget(environment({[DEPLOYMENT_ORIGIN_VARIABLE]: "http://staging.example.com"})),
		).toThrow(`${DEPLOYMENT_ORIGIN_VARIABLE} must be an https origin, but it is "http://staging.example.com"`);
	});

	it("refuses an origin carrying a path, a query, or a fragment", () => {
		expect(() =>
			resolveDeploymentTarget(environment({[DEPLOYMENT_ORIGIN_VARIABLE]: `${ORIGIN}/deck?a=1`})),
		).toThrow(`${DEPLOYMENT_ORIGIN_VARIABLE} must be a bare origin, but it is "${ORIGIN}/deck?a=1"`);
	});

	it("refuses to answer real questions on production unless that is asked for by name", () => {
		expect(() =>
			resolveDeploymentTarget(
				environment({
					[DEPLOYMENT_ORIGIN_VARIABLE]: "https://yepnope.app",
					[DEPLOYMENT_PASSKEY_VARIABLE]: encodeAutomationPasskey({...PASSKEY, rpId: "yepnope.app"}),
				}),
			),
		).toThrow(
			"refusing to run the deployed core-loop check against yepnope.app: it turns AFK on, routes real " +
				`questions to the account's deck, and answers them. Set ${DEPLOYMENT_PRODUCTION_OVERRIDE_VARIABLE}=1 ` +
				"to run it there anyway.",
		);
	});

	it("runs against production when that override is set by name", () => {
		const passkey = {...PASSKEY, rpId: "yepnope.app"};
		expect(
			resolveDeploymentTarget(
				environment({
					[DEPLOYMENT_ORIGIN_VARIABLE]: "https://yepnope.app",
					[DEPLOYMENT_PASSKEY_VARIABLE]: encodeAutomationPasskey(passkey),
					[DEPLOYMENT_PRODUCTION_OVERRIDE_VARIABLE]: "1",
				}),
			),
		).toStrictEqual({origin: "https://yepnope.app", passkey});
	});

	it("names the enrollment command when the deployment has no automation passkey", () => {
		expect(() => resolveDeploymentTarget(environment({[DEPLOYMENT_PASSKEY_VARIABLE]: undefined}))).toThrow(
			`${DEPLOYMENT_PASSKEY_VARIABLE} is not set, so the check cannot sign a browser in. ` +
				"Enroll one once with `just enroll-deployment-passkey`.",
		);
	});

	it("refuses a passkey blob that is not the documented shape", () => {
		expect(() =>
			resolveDeploymentTarget(environment({[DEPLOYMENT_PASSKEY_VARIABLE]: Buffer.from("{}").toString("base64")})),
		).toThrow(`${DEPLOYMENT_PASSKEY_VARIABLE} is not an enrolled automation passkey`);
	});

	it("refuses a passkey blob that is not base64 at all", () => {
		expect(() => resolveDeploymentTarget(environment({[DEPLOYMENT_PASSKEY_VARIABLE]: "not base64 ***"}))).toThrow(
			`${DEPLOYMENT_PASSKEY_VARIABLE} is not an enrolled automation passkey`,
		);
	});

	it("refuses a passkey enrolled against a different deployment", () => {
		expect(() =>
			resolveDeploymentTarget(
				environment({
					[DEPLOYMENT_PASSKEY_VARIABLE]: encodeAutomationPasskey({...PASSKEY, rpId: "yepnope.app"}),
				}),
			),
		).toThrow(
			`${DEPLOYMENT_PASSKEY_VARIABLE} was enrolled against yepnope.app, but ${DEPLOYMENT_ORIGIN_VARIABLE} is ` +
				"yepnope-staging.example.workers.dev. A passkey only signs in to the origin it was created on.",
		);
	});
});
