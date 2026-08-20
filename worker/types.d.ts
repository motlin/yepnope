declare module "*.sql" {
	const content: string;
	export default content;
}

// Social provider credentials are optional: a deployment without them simply never offers that
// provider. See `authenticationMethods` in worker/auth.ts.
//
// The Turnstile pair is optional in the same shape but not in the same spirit. Both keys present
// means every public authentication surface demands a redeemed token; both absent is allowed only
// on a loopback deployment; anything else fails closed. See `worker/turnstile.ts`.
//
// TURNSTILE_SITEVERIFY is a binding, not a var, and no Wrangler configuration declares it. Only the
// browser end-to-end Worker supplies one, so that its Playwright suite can redeem tokens in process
// instead of reaching Cloudflare.
interface Env {
	BETTER_AUTH_SECRET: string;
	GITHUB_CLIENT_ID?: string | undefined;
	GITHUB_CLIENT_SECRET?: string | undefined;
	GOOGLE_CLIENT_ID?: string | undefined;
	GOOGLE_CLIENT_SECRET?: string | undefined;
	TURNSTILE_SECRET_KEY?: string | undefined;
	TURNSTILE_SITEVERIFY?: {fetch: (request: Request) => Promise<Response>} | undefined;
	TURNSTILE_SITE_KEY?: string | undefined;
	VAPID_PRIVATE_JWK: string;
}

declare namespace Cloudflare {
	interface Env {
		BETTER_AUTH_SECRET: string;
		GITHUB_CLIENT_ID?: string | undefined;
		GITHUB_CLIENT_SECRET?: string | undefined;
		GOOGLE_CLIENT_ID?: string | undefined;
		GOOGLE_CLIENT_SECRET?: string | undefined;
		TURNSTILE_SECRET_KEY?: string | undefined;
		TURNSTILE_SITEVERIFY?: {fetch: (request: Request) => Promise<Response>} | undefined;
		TURNSTILE_SITE_KEY?: string | undefined;
		VAPID_PRIVATE_JWK: string;
	}
}
