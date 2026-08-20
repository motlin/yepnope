import {z} from "zod";
import type {TurnstileSiteverify} from "./turnstile";

// 🧪 A stand-in for Cloudflare's Siteverify, used by the Worker suite and by the browser end-to-end
// Worker. It exists so human verification can be exercised without a network round trip and without
// a shared mutable account at Cloudflare: the same token grammar, the same documented test secret
// keys, the same single-use redemption, decided locally and identically on every run.
//
// Nothing in `worker/index.ts` reaches this file. Production always talks to the real endpoint.

/** Cloudflare's documented Turnstile test keys. https://developers.cloudflare.com/turnstile/troubleshooting/testing/ */
export const TURNSTILE_TEST_KEYS = {
	// Visible widget that always passes without an interaction.
	alwaysPassesSiteKey: "1x00000000000000000000AA",
	// Visible widget that always refuses to issue a token.
	alwaysBlocksSiteKey: "2x00000000000000000000AB",
	// Visible widget that forces an interactive challenge before issuing a token.
	forcesInteractionSiteKey: "3x00000000000000000000FF",
	alwaysPassesSecretKey: "1x0000000000000000000000000000000AA",
	alwaysFailsSecretKey: "2x0000000000000000000000000000000AA",
	alwaysSpentSecretKey: "3x0000000000000000000000000000000AA",
} as const;

/**
 * A real token is opaque to the browser and meaningful only to Siteverify. The stand-in keeps that
 * shape: the widget encodes its claims, and only this module can read them back.
 */
const TEST_TOKEN_PREFIX = "yepnope-test-turnstile.";

const tokenClaimsSchema = z.object({
	action: z.string(),
	expired: z.boolean().optional(),
	hostname: z.string(),
	nonce: z.string(),
});

type TokenClaims = z.infer<typeof tokenClaimsSchema>;

export function testTurnstileToken(claims: Omit<TokenClaims, "nonce"> & {nonce?: string}): string {
	return `${TEST_TOKEN_PREFIX}${btoa(JSON.stringify({nonce: crypto.randomUUID(), ...claims}))}`;
}

function testTurnstileClaims(token: string): TokenClaims | null {
	if (!token.startsWith(TEST_TOKEN_PREFIX)) {
		return null;
	}
	try {
		const parsed = tokenClaimsSchema.safeParse(JSON.parse(atob(token.slice(TEST_TOKEN_PREFIX.length))));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function refusal(...errorCodes: string[]): Response {
	return Response.json({"error-codes": errorCodes, success: false});
}

/**
 * One redemption ledger per instance, so a replayed token is refused for the same reason Cloudflare
 * refuses it: the token was already spent.
 */
export function createTestSiteverify(): TurnstileSiteverify {
	const spent = new Set<string>();
	return {
		fetch: async (request) => {
			const body = await request.formData();
			const secret = body.get("secret")?.toString() ?? "";
			const token = body.get("response")?.toString() ?? "";
			if (secret === TURNSTILE_TEST_KEYS.alwaysFailsSecretKey) {
				return refusal("invalid-input-response");
			}
			if (secret === TURNSTILE_TEST_KEYS.alwaysSpentSecretKey) {
				return refusal("timeout-or-duplicate");
			}
			if (secret !== TURNSTILE_TEST_KEYS.alwaysPassesSecretKey) {
				return refusal("invalid-input-secret");
			}
			if (token === "") {
				return refusal("missing-input-response");
			}
			const claims = testTurnstileClaims(token);
			if (claims === null) {
				return refusal("invalid-input-response");
			}
			if (claims.expired === true || spent.has(token)) {
				return refusal("timeout-or-duplicate");
			}
			spent.add(token);
			return Response.json({
				action: claims.action,
				challenge_ts: new Date().toISOString(),
				"error-codes": [],
				hostname: claims.hostname,
				success: true,
			});
		},
	};
}
