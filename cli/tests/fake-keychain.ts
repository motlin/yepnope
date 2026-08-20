import type {Keychain} from "../keychain";

/** An in-memory stand-in for the OS keychain, so a test never touches the developer's own. */
export function fakeKeychain(initial: Record<string, string> = {}): Keychain & {entries: Map<string, string>} {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		delete: async (account) => {
			entries.delete(account);
			return Promise.resolve();
		},
		read: async (account) => Promise.resolve(entries.get(account) ?? null),
		write: async (account, secret) => {
			entries.set(account, secret);
			return Promise.resolve();
		},
	};
}
