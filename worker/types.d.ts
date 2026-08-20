declare module "*.sql" {
	const content: string;
	export default content;
}

// Social provider credentials are optional: a deployment without them simply never offers that
// provider. See `authenticationMethods` in worker/auth.ts.
interface Env {
	BETTER_AUTH_SECRET: string;
	GITHUB_CLIENT_ID?: string | undefined;
	GITHUB_CLIENT_SECRET?: string | undefined;
	GOOGLE_CLIENT_ID?: string | undefined;
	GOOGLE_CLIENT_SECRET?: string | undefined;
	VAPID_PRIVATE_JWK: string;
}

declare namespace Cloudflare {
	interface Env {
		BETTER_AUTH_SECRET: string;
		GITHUB_CLIENT_ID?: string | undefined;
		GITHUB_CLIENT_SECRET?: string | undefined;
		GOOGLE_CLIENT_ID?: string | undefined;
		GOOGLE_CLIENT_SECRET?: string | undefined;
		VAPID_PRIVATE_JWK: string;
	}
}
