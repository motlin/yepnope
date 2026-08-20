import {credentialStore, storedCredential, type CredentialStore} from "./credentials";
import {pollDeviceToken, registerClient, requestDeviceCode, revokeRefreshToken} from "./oauth";

// 📟 Sign-in is a browser approval, not a copied secret. Nothing this command prints is a credential:
// the user code authorizes nothing on its own and is useless the moment it is approved or expires.

export interface LoginDependencies {
	baseUrl: string;
	clientName: string;
	sleep: (milliseconds: number) => Promise<void>;
	store: CredentialStore;
	write: (text: string) => void;
}

function formatUserCode(userCode: string): string {
	return userCode.length === 8 ? `${userCode.slice(0, 4)}-${userCode.slice(4)}` : userCode;
}

export async function runLoginCommand(dependencies: LoginDependencies): Promise<void> {
	const clientId = await registerClient(dependencies.baseUrl, dependencies.clientName);
	const code = await requestDeviceCode(dependencies.baseUrl, clientId);
	dependencies.write(
		`Open ${code.verification_uri_complete ?? code.verification_uri} and approve this code:\n\n` +
			`    ${formatUserCode(code.user_code)}\n\n` +
			`It expires in ${String(Math.round(code.expires_in / 60))} minutes. Waiting for approval...\n`,
	);
	let interval = code.interval * 1_000;
	const deadline = Date.now() + code.expires_in * 1_000;
	while (Date.now() < deadline) {
		await dependencies.sleep(interval);
		const outcome = await pollDeviceToken(dependencies.baseUrl, clientId, code.device_code);
		if (outcome.status === "issued") {
			await dependencies.store.save(storedCredential(clientId, outcome.tokens));
			dependencies.write(
				"Approved. The credential is in this machine's keychain; revoke it any time under " +
					"Settings > Connected MCP clients.\n",
			);
			return;
		}
		if (outcome.status === "failed") {
			throw new Error(outcome.reason);
		}
		if (outcome.status === "slow_down") {
			interval += 5_000;
		}
	}
	throw new Error("the device code expired before it was approved. Run `yepnope login` again.");
}

export async function runLogoutCommand(baseUrl: string, store = credentialStore(baseUrl)): Promise<string> {
	const credential = await store.load();
	if (credential === null) {
		return `No YepNope credential was stored for ${baseUrl}.\n`;
	}
	await revokeRefreshToken(baseUrl, credential.clientId, credential.refreshToken);
	await store.clear();
	return "Signed out. The stored credential is revoked and removed from this machine's keychain.\n";
}
