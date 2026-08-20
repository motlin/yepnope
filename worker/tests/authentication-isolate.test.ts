import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {passkeyStackLoaded, withRequestBackgroundTasks, workerAuthentication, workerAuthenticationFor} from "../auth";
import {API_ORIGIN, humanVerificationHeader, worker} from "./helpers";

interface RecordedExecutionContext {
	context: ExecutionContext;
	deferred: Array<Promise<unknown>>;
}

function recordingExecutionContext(): RecordedExecutionContext {
	const deferred: Array<Promise<unknown>> = [];
	return {
		deferred,
		context: {
			props: {},
			passThroughOnException: () => undefined,
			waitUntil: (promise: Promise<unknown>) => deferred.push(promise),
			exports: {},
		} as unknown as ExecutionContext,
	};
}

describe("Isolate-wide authentication", () => {
	// 🧊 Cold-start budget. The WebAuthn stack (@simplewebauthn/server plus the @peculiar ASN.1 and
	// X.509 packages) costs ~24 ms of V8 compile-and-evaluate and registers its ASN.1 converters at
	// module-eval time. Only /api/auth/passkey/* can use any of it, so an isolate that never serves
	// a passkey ceremony must never pay for it. This has to be the first assertion in the file: once
	// a passkey request loads the stack, the isolate keeps it.
	it("loads the WebAuthn stack only once a passkey ceremony asks for it", async () => {
		expect(passkeyStackLoaded()).toBe(false);

		await workerAuthenticationFor(env, "/api/auth/get-session");
		expect(passkeyStackLoaded()).toBe(false);

		await workerAuthenticationFor(env, "/api/auth/passkey/generate-authenticate-options");
		expect(passkeyStackLoaded()).toBe(true);
	});

	it("serves passkey ceremonies from the lazily loaded instance", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
			headers: {Origin: API_ORIGIN},
		});

		expect(response.status).toBe(200);
		const options = await response.json<{challenge: string; rpId: string}>();
		expect(options.rpId).toBe("yepnope.app");
		expect(options.challenge.length).toBeGreaterThan(0);
	});

	it("builds the authentication instance once per isolate", () => {
		expect(workerAuthentication(env)).toBe(workerAuthentication(env));
	});

	it("reuses one instance across every authenticated route", async () => {
		await expect(workerAuthenticationFor(env, "/api/auth/get-session")).resolves.toBe(workerAuthentication(env));
		await expect(workerAuthenticationFor(env, "/.well-known/oauth-protected-resource")).resolves.toBe(
			workerAuthentication(env),
		);
	});

	it("keeps the passkey instance separate from the shared one and reuses it too", async () => {
		const withPasskeys = await workerAuthenticationFor(env, "/api/auth/passkey/list-user-passkeys");

		expect(withPasskeys).not.toBe(workerAuthentication(env));
		await expect(workerAuthenticationFor(env, "/api/auth/passkey/generate-register-options")).resolves.toBe(
			withPasskeys,
		);
	});

	// ⏳ The shared instance cannot capture an ExecutionContext, so the one paying for a deferred
	// email has to be the one the request arrived on — not whichever request happened to arrive
	// last. Two overlapping requests, one of which sends mail, prove which context is charged.
	it("charges a deferred email to the request that asked for it", async () => {
		const sender = recordingExecutionContext();
		const bystander = recordingExecutionContext();
		const authentication = workerAuthentication(env);

		const [magicLink, session] = await Promise.all([
			withRequestBackgroundTasks(sender.context, async () =>
				authentication.handler(
					new Request(`${API_ORIGIN}/api/auth/sign-in/magic-link`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Origin: API_ORIGIN,
							...humanVerificationHeader("sign_in"),
						},
						body: JSON.stringify({callbackURL: "/", email: `isolate-${crypto.randomUUID()}@example.com`}),
					}),
				),
			),
			withRequestBackgroundTasks(bystander.context, async () =>
				authentication.handler(new Request(`${API_ORIGIN}/api/auth/get-session`)),
			),
		]);

		expect(magicLink.status).toBe(200);
		expect(session.status).toBe(200);
		expect(sender.deferred.length).toBe(1);
		expect(bystander.deferred.length).toBe(0);
	});

	it("rebuilds when the environment it was built for is replaced", () => {
		const shared = workerAuthentication(env);

		expect(workerAuthentication({...env})).not.toBe(shared);
	});
});
