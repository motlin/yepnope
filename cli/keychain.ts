import {execFile} from "node:child_process";
import {platform} from "node:process";

// 🔐 The hook's credential is a refresh token that can mint questions on the account for a month, so
// it lives where the operating system already keeps secrets and nowhere else: not in a dotfile the
// next `cat` prints, not in an environment variable every child process inherits, not in a settings
// file that gets committed. There is no fallback store on purpose — a machine with no keychain gets
// an error telling it to sign in again, not a plaintext copy.

const SERVICE = "yepnope";

class KeychainUnavailableError extends Error {}

interface CommandResult {
	code: number;
	stderr: string;
	stdout: string;
}

/**
 * A non-zero exit is an answer — "no such keychain item" is one — so only a failure to run the
 * program at all is raised. `code` is the exit status when the program ran and an errno string when
 * it did not, which is exactly the distinction this needs.
 */
async function run(command: string, argumentList: readonly string[], input?: string): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(command, [...argumentList], (error, stdout, stderr) => {
			if (error === null) {
				resolve({code: 0, stderr, stdout});
				return;
			}
			if (typeof error.code === "number") {
				resolve({code: error.code, stderr, stdout});
				return;
			}
			reject(error.code === "ENOENT" ? new KeychainUnavailableError(`${command} is not installed`) : error);
		});
		child.stdin?.end(input ?? "");
	});
}

export interface Keychain {
	delete: (account: string) => Promise<void>;
	read: (account: string) => Promise<string | null>;
	write: (account: string, secret: string) => Promise<void>;
}

// 🍎 `security` takes the secret as an argument rather than on stdin. macOS shows a process's
// arguments only to the user running it, and that user can already unlock this keychain item, so the
// exposure is bounded by the same trust boundary the secret is stored behind.
const macOsKeychain: Keychain = {
	async delete(account) {
		await run("security", ["delete-generic-password", "-a", account, "-s", SERVICE]);
	},
	async read(account) {
		const result = await run("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
		return result.code === 0 ? result.stdout.trimEnd() : null;
	},
	async write(account, secret) {
		const result = await run("security", [
			"add-generic-password",
			"-U",
			"-a",
			account,
			"-s",
			SERVICE,
			"-l",
			`YepNope (${account})`,
			"-w",
			secret,
		]);
		if (result.code !== 0) {
			throw new Error(`could not write to the macOS keychain: ${result.stderr.trim()}`);
		}
	},
};

const secretServiceKeychain: Keychain = {
	async delete(account) {
		await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
	},
	async read(account) {
		const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
		return result.code === 0 && result.stdout !== "" ? result.stdout.trimEnd() : null;
	},
	async write(account, secret) {
		const result = await run(
			"secret-tool",
			["store", "--label", `YepNope (${account})`, "service", SERVICE, "account", account],
			secret,
		);
		if (result.code !== 0) {
			throw new Error(`could not write to the Secret Service keychain: ${result.stderr.trim()}`);
		}
	},
};

export function systemKeychain(): Keychain {
	if (platform === "darwin") {
		return macOsKeychain;
	}
	if (platform === "linux") {
		return secretServiceKeychain;
	}
	throw new KeychainUnavailableError(`no supported OS keychain on ${platform}`);
}
