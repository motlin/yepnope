declare module "*.sql" {
	const content: string;
	export default content;
}

interface Env {
	BETTER_AUTH_SECRET: string;
	VAPID_PRIVATE_JWK: string;
}

declare namespace Cloudflare {
	interface Env {
		BETTER_AUTH_SECRET: string;
		VAPID_PRIVATE_JWK: string;
	}
}
