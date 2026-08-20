import {z} from "zod";
import {systemKeychain, type Keychain} from "./keychain";
import {refreshTokens, type TokenSet} from "./oauth";

// 🗝️ One stored record per service origin, so a development sign-in and a production one cannot
// overwrite each other. The access token rides along with the refresh token because it is worth ten
// minutes: a burst of permission prompts should cost one refresh, not one per prompt.

const storedCredentialSchema = z.object({
	accessToken: z.string().min(1),
	clientId: z.string().min(1),
	expiresAt: z.number(),
	refreshToken: z.string().min(1),
});

export type StoredCredential = z.infer<typeof storedCredentialSchema>;

export class NotSignedInError extends Error {
	constructor(baseUrl: string) {
		super(`no YepNope credential for ${baseUrl}. Run \`yepnope login\` to authorize this machine.`);
	}
}

export interface CredentialStore {
	clear: () => Promise<void>;
	load: () => Promise<StoredCredential | null>;
	save: (credential: StoredCredential) => Promise<void>;
}

export function credentialStore(baseUrl: string, keychain: Keychain = systemKeychain()): CredentialStore {
	const account = new URL(baseUrl).origin;
	return {
		clear: async () => keychain.delete(account),
		load: async () => {
			const stored = await keychain.read(account);
			if (stored === null) {
				return null;
			}
			const parsed = storedCredentialSchema.safeParse(JSON.parse(stored) as unknown);
			return parsed.success ? parsed.data : null;
		},
		save: async (credential) => keychain.write(account, JSON.stringify(credential)),
	};
}

export function storedCredential(clientId: string, tokens: TokenSet): StoredCredential {
	return {
		accessToken: tokens.accessToken,
		clientId,
		expiresAt: tokens.expiresAt,
		refreshToken: tokens.refreshToken,
	};
}

/**
 * A usable access token, refreshing and re-storing when the held one is spent. Refresh tokens rotate
 * on every use, so the write back is not an optimization: skipping it strands the next call.
 *
 * 🏁 Two permission prompts can fire at once, and with rotation there is no grace period: the second
 * process presents a refresh token the first one has already spent and is refused. That is not a
 * dead credential, only a lost race, so a refusal re-reads the keychain once — by then the winner
 * has usually written the token both of them wanted.
 */
export async function accessToken(baseUrl: string, store: CredentialStore, now = Date.now()): Promise<string> {
	const credential = await store.load();
	if (credential === null) {
		throw new NotSignedInError(baseUrl);
	}
	if (credential.expiresAt > now) {
		return credential.accessToken;
	}
	let refreshed;
	try {
		refreshed = await refreshTokens(baseUrl, credential.clientId, credential.refreshToken);
	} catch (error) {
		const reloaded = await store.load();
		if (reloaded !== null && reloaded.expiresAt > now && reloaded.refreshToken !== credential.refreshToken) {
			return reloaded.accessToken;
		}
		throw error;
	}
	await store.save(storedCredential(credential.clientId, refreshed));
	return refreshed.accessToken;
}
