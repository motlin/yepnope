import {z} from "zod";

/**
 * 🚦 The configuration gate `just release` runs before it deploys anything.
 *
 * Every other guard in `scripts/release.ts` asks the repository a question — is the tree clean, is
 * the branch current, is this commit already released. None of them can see the thing that actually
 * takes production down: a Worker deployed without the names it reads at runtime. `worker/turnstile.ts`
 * fails closed on purpose, so a `yepnope.app` deploy missing either Turnstile key answers every
 * sign-in, create-account, password-reset, and verification-resend request with 403 — a whole signed-out
 * surface, discovered by the first visitor rather than by the operator. The end-to-end suite cannot
 * catch it either: its Worker is a loopback deployment, and loopback is the one hostname where
 * missing keys are legal.
 *
 * So this asks Cloudflare rather than the repository, and it asks about every name the Worker reads
 * rather than only the pair that prompted it. Names only: no secret value is requested, printed, or
 * recorded anywhere — `wrangler secret list` discloses names, and the dry run discloses the
 * configuration already committed to `wrangler.jsonc`.
 */

/** The one origin this repository releases to. */
export const PRODUCTION_HOSTNAME = "yepnope.app";

/** The rehearsal deployment the release proves the core loop on before it touches production. */
export const STAGING_CONFIG = "wrangler.staging.jsonc";

const STAGING_PLACEHOLDER_HOSTNAME = "REPLACE_WITH_THE_STAGING_ORIGIN";
const SECRET_LIST: readonly string[] = ["exec", "wrangler", "secret", "list", "--format", "json"];
const BINDING_LIST: readonly string[] = ["exec", "wrangler", "deploy", "--dry-run"];
const STAGING_BINDING_LIST: readonly string[] = [...BINDING_LIST, "--config", STAGING_CONFIG];

export interface CommandResult {
	code: number;
	output: string;
}

export interface PreflightDependencies {
	readTextFile: (path: string) => Promise<string>;
	run: (command: string, commandArguments: readonly string[]) => Promise<CommandResult>;
}

export interface PreflightReport {
	bindings: readonly string[];
	secrets: readonly string[];
	staging: string;
	target: string;
}

/** A name the Worker reads at runtime, what it is for, and what the operator does when it is absent. */
interface Requirement {
	name: string;
	remedy: string;
	role: string;
}

const DECLARE_IN_CONFIGURATION = "Declare it in wrangler.jsonc.";

function secretRemedy(name: string): string {
	return `Set it with \`vp exec wrangler secret put ${name}\`.`;
}

// 🔌 Declared in `wrangler.jsonc`, so a missing one means the configuration itself lost a binding or
// a var. Wrangler prints bindings and plain vars in the same `env.NAME` table, and this checks both.
const REQUIRED_BINDINGS: readonly Requirement[] = [
	{
		name: "USER_DO",
		remedy: DECLARE_IN_CONFIGURATION,
		role: "the Durable Object each account's questions and answers live in",
	},
	{
		name: "EMAIL",
		remedy: DECLARE_IN_CONFIGURATION,
		role: "the Send Email binding that delivers verification and password-reset mail",
	},
	{name: "DB", remedy: DECLARE_IN_CONFIGURATION, role: "the D1 database accounts and OAuth clients live in"},
	{name: "AUTH_EMAIL_FROM", remedy: DECLARE_IN_CONFIGURATION, role: "the address authentication mail is sent from"},
	{
		name: "BETTER_AUTH_URL",
		remedy: `Set it to https://${PRODUCTION_HOSTNAME} in wrangler.jsonc.`,
		role: "the deployment's own origin, which is also the hostname every Turnstile token is checked against",
	},
	{name: "VAPID_SUBJECT", remedy: DECLARE_IN_CONFIGURATION, role: "the contact address web push requires"},
];

// 🔑 Wrangler secrets, which live only in Cloudflare. A public value may legitimately be carried as
// a plain var instead, so each of these is satisfied by either source.
const TURNSTILE_ROLE =
	"half of the human-verification pair. A deployment whose origin is not loopback and lacks either key " +
	"fails closed, and every sign-in, create-account, password-reset, and verification-resend request " +
	"answers 403";

const REQUIRED_SECRETS: readonly Requirement[] = [
	{
		name: "BETTER_AUTH_SECRET",
		remedy: secretRemedy("BETTER_AUTH_SECRET"),
		role: "the key every session and token is signed with",
	},
	{
		name: "VAPID_PRIVATE_JWK",
		remedy: secretRemedy("VAPID_PRIVATE_JWK"),
		role: "the key web-push notifications are signed with",
	},
	{name: "TURNSTILE_SITE_KEY", remedy: secretRemedy("TURNSTILE_SITE_KEY"), role: TURNSTILE_ROLE},
	{name: "TURNSTILE_SECRET_KEY", remedy: secretRemedy("TURNSTILE_SECRET_KEY"), role: TURNSTILE_ROLE},
];

// Deliberately not required: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID, and
// GOOGLE_CLIENT_SECRET. A deployment without a provider's pair simply never offers that provider,
// which is a choice rather than a broken deployment. TURNSTILE_SITEVERIFY is absent by design too:
// only the browser end-to-end Worker binds one, and production falls back to the global `fetch`.

/** Refuses the release and names every requirement the deployment does not meet, not just the first. */
export class DeploymentNotConfiguredError extends Error {
	readonly missing: readonly string[];

	constructor(problems: readonly string[], missing: readonly string[]) {
		super(
			`refusing to release: the ${PRODUCTION_HOSTNAME} Worker is missing configuration it reads at runtime\n` +
				problems.map((problem) => `  - ${problem}`).join("\n"),
		);
		this.missing = missing;
		this.name = "DeploymentNotConfiguredError";
	}
}

const secretListSchema = z.array(z.object({name: z.string()}));

async function deployedSecretNames(dependencies: PreflightDependencies): Promise<ReadonlySet<string>> {
	const result = await dependencies.run("vp", SECRET_LIST);
	if (result.code !== 0) {
		throw new Error(
			`\`wrangler secret list\` failed with exit code ${result.code}, ` +
				`so this release cannot tell whether ${PRODUCTION_HOSTNAME} is configured`,
		);
	}
	// The array is the whole answer, but stdout and stderr are merged, so take the array and ignore
	// anything Wrangler printed around it.
	const start = result.output.indexOf("[");
	const end = result.output.lastIndexOf("]");
	const names = start === -1 || end < start ? null : parseSecretNames(result.output.slice(start, end + 1));
	if (names === null) {
		throw new Error("`wrangler secret list` did not print the documented JSON array of secret names");
	}
	return names;
}

function parseSecretNames(json: string): ReadonlySet<string> | null {
	try {
		return new Set(secretListSchema.parse(JSON.parse(json) as unknown).map((secret) => secret.name));
	} catch {
		return null;
	}
}

/**
 * The `env.NAME (value)` rows of the dry run's binding table, keyed by name. A var carries its
 * quoted value; a binding carries a description of the resource, which nothing here reads.
 */
function parseBindings(output: string): ReadonlyMap<string, string | null> {
	const bindings = new Map<string, string | null>();
	for (const line of output.split("\n")) {
		const name = /^env\.(\w+)/.exec(line)?.[1];
		if (name === undefined) {
			continue;
		}
		const open = line.indexOf("(");
		const close = line.lastIndexOf(")");
		bindings.set(name, open === -1 || close < open ? null : line.slice(open + 1, close));
	}
	return bindings;
}

async function declaredBindings(dependencies: PreflightDependencies): Promise<ReadonlyMap<string, string | null>> {
	const result = await dependencies.run("vp", BINDING_LIST);
	const cannotTell = `so this release cannot tell what ${PRODUCTION_HOSTNAME} would be deployed with`;
	if (result.code !== 0) {
		throw new Error(`\`wrangler deploy --dry-run\` failed with exit code ${result.code}, ${cannotTell}`);
	}
	const bindings = parseBindings(result.output);
	if (bindings.size === 0) {
		throw new Error(`\`wrangler deploy --dry-run\` listed no bindings, ${cannotTell}`);
	}
	return bindings;
}

/** A var's value as Wrangler prints it, quotes stripped; null for a binding, which has no value. */
function variableValue(printed: string | null | undefined): string | null {
	const quoted = printed === null || printed === undefined ? null : /^"(.*)"$/s.exec(printed)?.[1];
	return quoted ?? null;
}

function originHostname(printed: string | null): string | null {
	if (printed === null) {
		return null;
	}
	try {
		return new URL(printed).hostname;
	} catch {
		return null;
	}
}

function originProblem(bindings: ReadonlyMap<string, string | null>): string | null {
	const printed = variableValue(bindings.get("BETTER_AUTH_URL"));
	if (originHostname(printed) === PRODUCTION_HOSTNAME) {
		return null;
	}
	// 🎯 The origin decides which tokens the Worker will redeem, so a wrong one refuses every token
	// the real site mints — and a loopback one silently waives the check this release just shipped.
	return (
		`BETTER_AUTH_URL is ${printed === null ? "not an origin at all" : `"${printed}"`}, but this releases ` +
		`to ${PRODUCTION_HOSTNAME}: a Worker whose origin is wrong rejects every Turnstile token minted ` +
		`against the real one. Set it to https://${PRODUCTION_HOSTNAME} in wrangler.jsonc.`
	);
}

/**
 * 🎭 Where the release rehearses. `wrangler.staging.jsonc` deploys the same `worker/index.ts` onto
 * its own database and its own Durable Object namespace, and the origin it answers on belongs to
 * whoever owns the Cloudflare account, so it is read out of the configuration rather than guessed.
 * A Worker refuses every token minted against an origin that is not its own, which is exactly why a
 * placeholder here has to stop the release rather than produce a staging deployment that fails
 * every sign-in.
 */
async function stagingDeploymentOrigin(dependencies: PreflightDependencies): Promise<string> {
	const result = await dependencies.run("vp", STAGING_BINDING_LIST);
	const cannotTell = "so this release cannot tell where to prove the core loop before deploying production";
	if (result.code !== 0) {
		throw new Error(
			`\`wrangler deploy --dry-run --config ${STAGING_CONFIG}\` failed with exit code ${result.code}, ` +
				cannotTell,
		);
	}

	// Wrangler's human-readable binding table truncates long values to fit the terminal. The dry run
	// still proves that Wrangler can resolve every resource, but the checked-in config is the source
	// of truth for the exact origin passed to the deployed core-loop check.
	const source = await dependencies.readTextFile(STAGING_CONFIG);
	const declarations = [...source.matchAll(/^\s*"BETTER_AUTH_URL"\s*:\s*"([^"\n]+)"\s*,?\s*$/gmu)];
	const printed = declarations.length === 1 ? (declarations[0]?.[1] ?? null) : null;
	const hostname = originHostname(printed);
	if (hostname === null) {
		throw new Error(`${STAGING_CONFIG} declares no BETTER_AUTH_URL origin, ${cannotTell}`);
	}
	if (hostname.toUpperCase() === STAGING_PLACEHOLDER_HOSTNAME) {
		throw new Error(
			`${STAGING_CONFIG} still carries its placeholder origin. Deploy staging once with ` +
				"`just deploy-staging`, then set BETTER_AUTH_URL to the origin Wrangler printed.",
		);
	}
	if (hostname === PRODUCTION_HOSTNAME) {
		throw new Error(
			`${STAGING_CONFIG} points at ${PRODUCTION_HOSTNAME}, so the release would rehearse on production. ` +
				"Staging has to be its own deployment, with its own database.",
		);
	}
	return new URL(printed ?? "").origin;
}

/**
 * Checks one deployment against every name the Worker reads and returns what it found, or refuses
 * the release with all of the unmet requirements at once.
 */
export async function preflightDeployment(dependencies: PreflightDependencies): Promise<PreflightReport> {
	const secrets = await deployedSecretNames(dependencies);
	const bindings = await declaredBindings(dependencies);

	const problems: string[] = [];
	const missing: string[] = [];
	for (const requirement of REQUIRED_BINDINGS) {
		if (!bindings.has(requirement.name)) {
			problems.push(`${requirement.name} is not bound: ${requirement.role}. ${requirement.remedy}`);
			missing.push(requirement.name);
			continue;
		}
		const origin = requirement.name === "BETTER_AUTH_URL" ? originProblem(bindings) : null;
		if (origin !== null) {
			problems.push(origin);
			missing.push(requirement.name);
		}
	}
	for (const requirement of REQUIRED_SECRETS) {
		if (!secrets.has(requirement.name) && !bindings.has(requirement.name)) {
			problems.push(`${requirement.name} is not set: ${requirement.role}. ${requirement.remedy}`);
			missing.push(requirement.name);
		}
	}
	if (problems.length > 0) {
		throw new DeploymentNotConfiguredError(problems, missing);
	}

	return {
		bindings: [...bindings.keys()].sort(),
		secrets: [...secrets].sort(),
		staging: await stagingDeploymentOrigin(dependencies),
		target: PRODUCTION_HOSTNAME,
	};
}
