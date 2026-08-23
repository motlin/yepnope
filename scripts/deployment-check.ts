import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import {z} from "zod";
// Node runs this file directly, so the relative import carries the extension TypeScript allows.
import {PRODUCTION_HOSTNAME} from "./preflight.ts";

/**
 * 🔁 The runner for the one check that proves YepNope's core loop on a deployment nobody is sitting
 * in front of.
 *
 * Everything else that is green in this repository is green in a process on this machine: vitest,
 * workerd, and a headless browser talking to a loopback Worker whose email and Siteverify are
 * substituted. None of that can tell whether a real Cloudflare deployment still routes a question
 * from an OAuth-authenticated MCP client, through a Durable Object, over a WebSocket, onto a phone's
 * deck, and back into the blocking tool call. `tests/deployed/core-loop.spec.ts` does exactly that
 * against a deployed origin; this file decides which origin, refuses the ones that would be a
 * mistake, and hands the browser the credential it signs in with.
 *
 * ## What still needs a person, once per deployment
 *
 * The signed-out surface is deliberately hostile to automation: create-account, password sign-in,
 * emailed sign-in links, password reset, and verification resend are all Turnstile-gated, and
 * finishing a registration means reading a message Cloudflare delivered to a real inbox. A robot
 * cannot do either, and nothing here pretends otherwise or weakens the gate to make it possible.
 *
 * So a person creates the deployment's automation account once — register, solve the challenge,
 * follow the verification link — and then runs `just enroll-deployment-passkey`, which registers one
 * passkey through the real WebAuthn ceremony against a Chrome virtual authenticator and prints the
 * credential. Passkey sign-in is the one authenticated entry point that is not Turnstile-gated
 * (`HUMAN_VERIFICATION_ACTIONS` in `worker/auth.ts` lists every gated path, and no passkey route is
 * among them), so from then on every run signs itself in with no person present and no expiring
 * session to refresh. The deployment verifies that credential for real; the only thing standing in
 * for hardware is the authenticator holding the key.
 */

/** The deployed origin the check runs against, as a bare `https://host[:port]` string. */
export const DEPLOYMENT_ORIGIN_VARIABLE = "YEPNOPE_DEPLOYMENT_ORIGIN";

/** The enrolled automation passkey, base64 of the JSON `enroll-deployment-passkey` printed. */
export const DEPLOYMENT_PASSKEY_VARIABLE = "YEPNOPE_DEPLOYMENT_PASSKEY";

/**
 * A session established by hand, so enrollment needs no browser window. Turnstile is meant to refuse
 * an automated browser, so a person signs in normally in their own and hands the cookie over.
 */
export const DEPLOYMENT_SESSION_VARIABLE = "YEPNOPE_DEPLOYMENT_SESSION";

/**
 * The cookie Better Auth carries a session in. Over HTTPS it sets the `__Secure-` prefixed name, and
 * a deployment is always HTTPS, so the bare name authenticates nothing here.
 */
const SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";

/** Set to `1` to run the check against production, which answers real questions on the real deck. */
export const DEPLOYMENT_PRODUCTION_OVERRIDE_VARIABLE = "YEPNOPE_DEPLOYMENT_ALLOW_PRODUCTION";

const DEPLOYED_PLAYWRIGHT_CONFIG = "playwright.deployed.config.ts";

/**
 * One WebAuthn credential as Chrome's virtual authenticator stores it. The private key never reaches
 * the deployment: the browser signs the challenge with it exactly as a phone's secure element would,
 * and the Worker verifies the signature against the public key it recorded at enrollment.
 */
export interface AutomationPasskey {
	credentialId: string;
	privateKey: string;
	rpId: string;
	signCount: number;
	userHandle: string;
}

export interface DeploymentTarget {
	origin: string;
	passkey: AutomationPasskey;
}

const automationPasskeySchema = z
	.object({
		credentialId: z.string().min(1),
		privateKey: z.string().min(1),
		rpId: z.string().min(1),
		signCount: z.number().int().min(0),
		userHandle: z.string().min(1),
	})
	.strict();

export function encodeAutomationPasskey(passkey: AutomationPasskey): string {
	return Buffer.from(JSON.stringify(passkey), "utf8").toString("base64");
}

function decodeAutomationPasskey(encoded: string): AutomationPasskey {
	const rejection = new Error(
		`${DEPLOYMENT_PASSKEY_VARIABLE} is not an enrolled automation passkey. ` +
			"Enroll one with `just enroll-deployment-passkey` and store what it prints, unedited.",
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	} catch {
		throw rejection;
	}
	const credential = automationPasskeySchema.safeParse(parsed);
	if (!credential.success) {
		throw rejection;
	}
	return credential.data;
}

function deploymentOrigin(printed: string | undefined): URL {
	if (printed === undefined || printed.trim() === "") {
		throw new Error(
			`${DEPLOYMENT_ORIGIN_VARIABLE} is not set, so there is no deployment to prove the core loop against. ` +
				"Set it to the staging Worker's origin; `just deploy-staging` prints it.",
		);
	}
	const value = printed.trim();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${DEPLOYMENT_ORIGIN_VARIABLE} must be an https origin, but it is "${value}"`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`${DEPLOYMENT_ORIGIN_VARIABLE} must be an https origin, but it is "${value}"`);
	}
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new Error(`${DEPLOYMENT_ORIGIN_VARIABLE} must be a bare origin, but it is "${value}"`);
	}
	return url;
}

/**
 * Reads the deployment this run targets, or refuses with the one thing the operator has to do next.
 * Production is refused by name rather than by accident: the check turns AFK on and answers the
 * questions it asks, which on the real deployment happens on the real phone.
 */
export function resolveDeploymentTarget(environment: Record<string, string | undefined>): DeploymentTarget {
	const url = deploymentOrigin(environment[DEPLOYMENT_ORIGIN_VARIABLE]);
	if (url.hostname === PRODUCTION_HOSTNAME && environment[DEPLOYMENT_PRODUCTION_OVERRIDE_VARIABLE] !== "1") {
		throw new Error(
			`refusing to run the deployed core-loop check against ${PRODUCTION_HOSTNAME}: it turns AFK on, ` +
				"routes real questions to the account's deck, and answers them. Set " +
				`${DEPLOYMENT_PRODUCTION_OVERRIDE_VARIABLE}=1 to run it there anyway.`,
		);
	}
	const encodedPasskey = environment[DEPLOYMENT_PASSKEY_VARIABLE];
	if (encodedPasskey === undefined || encodedPasskey.trim() === "") {
		throw new Error(
			`${DEPLOYMENT_PASSKEY_VARIABLE} is not set, so the check cannot sign a browser in. ` +
				"Enroll one once with `just enroll-deployment-passkey`.",
		);
	}
	const passkey = decodeAutomationPasskey(encodedPasskey.trim());
	if (passkey.rpId !== url.hostname) {
		throw new Error(
			`${DEPLOYMENT_PASSKEY_VARIABLE} was enrolled against ${passkey.rpId}, but ` +
				`${DEPLOYMENT_ORIGIN_VARIABLE} is ${url.hostname}. ` +
				"A passkey only signs in to the origin it was created on.",
		);
	}
	return {origin: url.origin, passkey};
}

async function runPlaywright(target: DeploymentTarget): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["node_modules/playwright/cli.js", "test", "--config", DEPLOYED_PLAYWRIGHT_CONFIG],
			{
				env: {
					...process.env,
					[DEPLOYMENT_ORIGIN_VARIABLE]: target.origin,
					[DEPLOYMENT_PASSKEY_VARIABLE]: encodeAutomationPasskey(target.passkey),
				},
				stdio: "inherit",
			},
		);
		child.on("error", reject);
		child.on("close", (code) => {
			resolve(code ?? 1);
		});
	});
}

/**
 * The one-time human step. A person signs in to the deployment in a real window — solving the
 * Turnstile challenge and, the first time, following the emailed verification link — and this
 * registers a passkey against a virtual authenticator and prints the credential to store.
 */
async function enrollPasskey(origin: string, sessionToken: string | undefined): Promise<void> {
	const {chromium} = await import("playwright");
	// A session handed in was established in a person's own browser, where Turnstile passes, so the
	// ceremony needs no window and no one to watch it. Without one, a window has to open, and only
	// the paths outside `HUMAN_VERIFICATION_ACTIONS` — social and passkey — can complete in it.
	const browser = await chromium.launch({headless: sessionToken !== undefined});
	try {
		const context = await browser.newContext();
		if (sessionToken !== undefined) {
			await context.addCookies([
				{
					domain: new URL(origin).hostname,
					httpOnly: true,
					name: SESSION_COOKIE_NAME,
					path: "/",
					sameSite: "Lax",
					secure: true,
					value: sessionToken,
				},
			]);
		}
		const page = await context.newPage();
		const client = await context.newCDPSession(page);
		await client.send("WebAuthn.enable");
		const {authenticatorId} = await client.send("WebAuthn.addVirtualAuthenticator", {
			options: {
				automaticPresenceSimulation: true,
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				protocol: "ctap2",
				transport: "internal",
			},
		});
		if (sessionToken === undefined) {
			await page.goto(`${origin}/sign-in`);
			process.stderr.write(
				"Sign in to the deployment in the window that just opened, then leave it alone.\n" +
					"Turnstile refuses an automated browser, so use a social button rather than the password form.\n" +
					"If this account does not exist yet, create it here and follow the verification link first.\n",
			);
			await page.waitForURL(
				(url) => !url.pathname.startsWith("/sign-in") && !url.pathname.startsWith("/register"),
				{timeout: 15 * 60 * 1000},
			);
		}
		await page.goto(`${origin}/settings`);
		await page
			.getByRole("region", {name: "Sign-in methods"})
			.getByRole("button", {name: "Add a passkey"})
			.click({timeout: 60_000});
		await page.getByRole("region", {name: "Sign-in methods"}).getByRole("listitem").first().waitFor();
		const {credentials} = await client.send("WebAuthn.getCredentials", {authenticatorId});
		const credential = credentials.at(-1);
		if (credential === undefined) {
			throw new Error("the passkey ceremony completed without leaving a credential on the authenticator");
		}
		if (credential.userHandle === undefined || credential.rpId === undefined) {
			// A discoverable credential always carries both, and the check signs in without a
			// username, so one that does not is unusable rather than merely incomplete.
			throw new Error("the enrolled passkey is not discoverable, so it cannot sign in without a username");
		}
		const passkey: AutomationPasskey = {
			credentialId: credential.credentialId,
			privateKey: credential.privateKey,
			rpId: credential.rpId,
			signCount: credential.signCount,
			userHandle: credential.userHandle,
		};
		process.stderr.write(`\nStore this as ${DEPLOYMENT_PASSKEY_VARIABLE}:\n\n`);
		console.log(encodeAutomationPasskey(passkey));
	} finally {
		await browser.close();
	}
}

async function main(): Promise<void> {
	if (process.argv.includes("--enroll")) {
		const session = process.env[DEPLOYMENT_SESSION_VARIABLE]?.trim();
		await enrollPasskey(
			deploymentOrigin(process.env[DEPLOYMENT_ORIGIN_VARIABLE]).origin,
			session === undefined || session === "" ? undefined : session,
		);
		return;
	}
	process.exitCode = await runPlaywright(resolveDeploymentTarget(process.env));
}

const entryPath = process.argv.at(1);
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	await main();
}
