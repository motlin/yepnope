import type {drizzleAdapter} from "@better-auth/drizzle-adapter";

type AdapterFactory = ReturnType<typeof drizzleAdapter>;

/**
 * 🏁 drizzle reports a failed statement as "Failed query: <sql>" and files the driver's own message
 * — "UNIQUE constraint failed: …" — under `cause`. Better Auth plugins recognise a lost insert race
 * by matching that text on the error they catch. The OAuth provider seeds its resource row from
 * both `init` and the first request on a cold isolate, and without the driver's words it mistakes
 * the expected collision for a failure and answers that request with a 500.
 */
function withDriverMessage(caught: unknown): unknown {
	if (!(caught instanceof Error) || !(caught.cause instanceof Error)) {
		return caught;
	}
	return new Error(`${caught.message}: ${caught.cause.message}`, {cause: caught});
}

export function surfacingDriverMessages(factory: AdapterFactory): AdapterFactory {
	return (options) =>
		new Proxy(factory(options), {
			get(target, property, receiver): unknown {
				const value: unknown = Reflect.get(target, property, receiver);
				if (property !== "create" || typeof value !== "function") {
					return value;
				}
				return async (...parameters: unknown[]): Promise<unknown> => {
					try {
						return (await Reflect.apply(value, target, parameters)) as unknown;
					} catch (caught) {
						throw withDriverMessage(caught);
					}
				};
			},
		});
}
