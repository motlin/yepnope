import {describe, expect, it, vi} from "vitest";
import {
	preflightDeployment,
	DeploymentNotConfiguredError,
	type CommandResult,
	type PreflightDependencies,
} from "../scripts/preflight";

function ok(output = ""): CommandResult {
	return {code: 0, output};
}

// The `env.NAME (value)` rows `wrangler deploy --dry-run` prints for a correctly configured
// production Worker, column padding and all.
const PRODUCTION_BINDINGS: readonly string[] = [
	"env.USER_DO (UserDurableObject)                                         Durable Object            ",
	"env.EMAIL (unrestricted - senders: accounts@yepnope.app)                Send Email                ",
	"env.DB (yepnope)                                                        D1 Database               ",
	'env.AUTH_EMAIL_FROM ("accounts@yepnope.app")                            Environment Variable      ',
	'env.BETTER_AUTH_URL ("https://yepnope.app")                             Environment Variable      ',
	'env.VAPID_SUBJECT ("mailto:push@yepnope.app")                           Environment Variable      ',
];

const PRODUCTION_SECRETS: readonly string[] = [
	"BETTER_AUTH_SECRET",
	"TURNSTILE_SECRET_KEY",
	"TURNSTILE_SITE_KEY",
	"VAPID_PRIVATE_JWK",
];

function bindings(rows: readonly string[] = PRODUCTION_BINDINGS): CommandResult {
	return ok(
		[
			" ⛅️ wrangler 4.123.0",
			"───────────────────────────────────────────────",
			"✨ Read 14 files from the assets directory /Users/craig/projects/yepnope/dist",
			"Total Upload: 4418.01 KiB / gzip: 754.61 KiB",
			"Your Worker has access to the following bindings:",
			"Binding                                                                 Resource                  ",
			...rows,
			"",
			"--dry-run: exiting now.",
			"",
		].join("\n"),
	);
}

/** The production binding rows with one name dropped, standing in for a configuration that lost it. */
function bindingsWithout(name: string): readonly string[] {
	return PRODUCTION_BINDINGS.filter((row) => !row.startsWith(`env.${name} `));
}

function secrets(names: readonly string[] = PRODUCTION_SECRETS): CommandResult {
	return ok(
		JSON.stringify(
			names.map((name) => ({name, type: "secret_text"})),
			null,
			2,
		),
	);
}

const PREFLIGHT_CALLS = [
	["vp", ["exec", "wrangler", "secret", "list", "--format", "json"]],
	["vp", ["exec", "wrangler", "deploy", "--dry-run"]],
];

const STAGING_ORIGIN = "https://yepnope-staging.example.workers.dev";
const STAGING_CALL = ["vp", ["exec", "wrangler", "deploy", "--dry-run", "--config", "wrangler.staging.jsonc"]];

/** The staging dry run, whose only interesting row is the origin the core-loop check will target. */
function stagingBindings(origin: string = STAGING_ORIGIN): CommandResult {
	return bindings([
		"env.USER_DO (UserDurableObject)                                         Durable Object            ",
		"env.DB (yepnope-staging)                                                D1 Database               ",
		`env.BETTER_AUTH_URL ("${origin}")                                       Environment Variable      `,
	]);
}

function preflightRunner(results: readonly CommandResult[]) {
	const run = vi.fn<PreflightDependencies["run"]>();
	for (const result of results) {
		run.mockResolvedValueOnce(result);
	}
	return run;
}

async function refusal(run: ReturnType<typeof preflightRunner>): Promise<DeploymentNotConfiguredError> {
	try {
		await preflightDeployment({run});
	} catch (error) {
		if (error instanceof DeploymentNotConfiguredError) {
			return error;
		}
		throw error;
	}
	throw new Error("the preflight accepted a deployment the test expected it to refuse");
}

describe("release preflight", () => {
	it("accepts a deployment that has every binding and secret the Worker reads", async () => {
		const run = preflightRunner([secrets(), bindings(), stagingBindings()]);

		expect(await preflightDeployment({run})).toStrictEqual({
			bindings: ["AUTH_EMAIL_FROM", "BETTER_AUTH_URL", "DB", "EMAIL", "USER_DO", "VAPID_SUBJECT"],
			secrets: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY", "VAPID_PRIVATE_JWK"],
			staging: STAGING_ORIGIN,
			target: "yepnope.app",
		});
		expect(run.mock.calls).toStrictEqual([...PREFLIGHT_CALLS, STAGING_CALL]);
	});

	it("refuses a production deployment that has neither Turnstile key, which fails closed", async () => {
		const run = preflightRunner([secrets(["BETTER_AUTH_SECRET", "VAPID_PRIVATE_JWK"]), bindings()]);

		const error = await refusal(run);

		expect(error.missing).toStrictEqual(["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]);
		expect(error.message).toContain("every sign-in, create-account, password-reset, and verification-resend");
		expect(error.message).toContain("vp exec wrangler secret put TURNSTILE_SITE_KEY");
	});

	it("refuses a half-configured Turnstile pair", async () => {
		const run = preflightRunner([
			secrets(["BETTER_AUTH_SECRET", "TURNSTILE_SITE_KEY", "VAPID_PRIVATE_JWK"]),
			bindings(),
		]);

		expect((await refusal(run)).missing).toStrictEqual(["TURNSTILE_SECRET_KEY"]);
	});

	it("accepts a public key carried as a plain var instead of a secret", async () => {
		const run = preflightRunner([
			secrets(["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "VAPID_PRIVATE_JWK"]),
			bindings([
				...PRODUCTION_BINDINGS,
				'env.TURNSTILE_SITE_KEY ("0x4AAAAAAA")                                   Environment Variable      ',
			]),
			stagingBindings(),
		]);

		expect((await preflightDeployment({run})).bindings).toContain("TURNSTILE_SITE_KEY");
	});

	it("refuses a deployment with no signing secret, whatever else is configured", async () => {
		const run = preflightRunner([
			secrets(["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY", "VAPID_PRIVATE_JWK"]),
			bindings(),
		]);

		expect((await refusal(run)).missing).toStrictEqual(["BETTER_AUTH_SECRET"]);
	});

	it("refuses a deployment whose configuration lost the email binding", async () => {
		const run = preflightRunner([secrets(), bindings(bindingsWithout("EMAIL"))]);

		const error = await refusal(run);

		expect(error.missing).toStrictEqual(["EMAIL"]);
		expect(error.message).toContain("wrangler.jsonc");
	});

	it("names every unmet requirement in one refusal rather than only the first", async () => {
		const run = preflightRunner([secrets([]), bindings(bindingsWithout("DB"))]);

		expect((await refusal(run)).missing).toStrictEqual([
			"DB",
			"BETTER_AUTH_SECRET",
			"VAPID_PRIVATE_JWK",
			"TURNSTILE_SITE_KEY",
			"TURNSTILE_SECRET_KEY",
		]);
	});

	it("refuses a deployment whose origin is not the production hostname", async () => {
		const run = preflightRunner([
			secrets(),
			bindings([
				...bindingsWithout("BETTER_AUTH_URL"),
				'env.BETTER_AUTH_URL ("https://staging.example.com")                     Environment Variable      ',
			]),
		]);

		const error = await refusal(run);

		expect(error.missing).toStrictEqual(["BETTER_AUTH_URL"]);
		expect(error.message).toContain('is "https://staging.example.com"');
	});

	it("refuses an origin that is not a URL at all", async () => {
		const run = preflightRunner([
			secrets(),
			bindings([
				...bindingsWithout("BETTER_AUTH_URL"),
				'env.BETTER_AUTH_URL ("yepnope.app")                                      Environment Variable      ',
			]),
		]);

		expect((await refusal(run)).missing).toStrictEqual(["BETTER_AUTH_URL"]);
	});

	it("refuses a loopback origin, the one place missing Turnstile keys would be legal", async () => {
		const run = preflightRunner([
			secrets(["BETTER_AUTH_SECRET", "VAPID_PRIVATE_JWK"]),
			bindings([
				...bindingsWithout("BETTER_AUTH_URL"),
				'env.BETTER_AUTH_URL ("http://localhost:5173")                           Environment Variable      ',
			]),
		]);

		expect((await refusal(run)).missing).toStrictEqual([
			"BETTER_AUTH_URL",
			"TURNSTILE_SITE_KEY",
			"TURNSTILE_SECRET_KEY",
		]);
	});

	it("fails loudly when the secret list cannot be read at all", async () => {
		const run = preflightRunner([{code: 1, output: "Authentication error [code: 10000]\n"}]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"`wrangler secret list` failed with exit code 1, so this release cannot tell whether yepnope.app is configured",
		);
		expect(run.mock.calls).toStrictEqual([PREFLIGHT_CALLS[0]]);
	});

	it("fails loudly when the secret list is not the documented JSON array", async () => {
		const run = preflightRunner([ok("no secrets here\n")]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"`wrangler secret list` did not print the documented JSON array of secret names",
		);
	});

	it("fails loudly when the configuration cannot be resolved", async () => {
		const run = preflightRunner([secrets(), {code: 1, output: "The assets directory ./dist does not exist.\n"}]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"`wrangler deploy --dry-run` failed with exit code 1, so this release cannot tell what yepnope.app would be deployed with",
		);
	});

	it("fails loudly when the dry run lists no bindings at all", async () => {
		const run = preflightRunner([secrets(), bindings([])]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"`wrangler deploy --dry-run` listed no bindings, so this release cannot tell what yepnope.app would be deployed with",
		);
	});

	it("refuses a staging configuration still carrying its placeholder origin", async () => {
		const run = preflightRunner([
			secrets(),
			bindings(),
			stagingBindings("https://REPLACE_WITH_THE_STAGING_ORIGIN"),
		]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"wrangler.staging.jsonc still carries its placeholder origin. Deploy staging once with " +
				"`just deploy-staging`, then set BETTER_AUTH_URL to the origin Wrangler printed.",
		);
	});

	it("refuses to rehearse the release on production itself", async () => {
		const run = preflightRunner([secrets(), bindings(), stagingBindings("https://yepnope.app")]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"wrangler.staging.jsonc points at yepnope.app, so the release would rehearse on production. " +
				"Staging has to be its own deployment, with its own database.",
		);
	});

	it("refuses a staging configuration that declares no origin", async () => {
		const run = preflightRunner([
			secrets(),
			bindings(),
			bindings(["env.DB (yepnope-staging)                                                D1 Database  "]),
		]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"wrangler.staging.jsonc declares no BETTER_AUTH_URL origin, so this release cannot tell where to " +
				"prove the core loop before deploying production",
		);
	});

	it("fails loudly when the staging configuration cannot be resolved", async () => {
		const run = preflightRunner([secrets(), bindings(), {code: 1, output: "Could not resolve D1 database\n"}]);

		await expect(preflightDeployment({run})).rejects.toThrow(
			"`wrangler deploy --dry-run --config wrangler.staging.jsonc` failed with exit code 1, so this release " +
				"cannot tell where to prove the core loop before deploying production",
		);
	});
});
