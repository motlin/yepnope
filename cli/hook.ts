import {accessToken, type CredentialStore} from "./credentials";

// 🪝 Claude Code runs this on every permission request. It is a bridge and nothing more: the hook
// JSON arrives on stdin, the Worker decides, and the decision goes back out on stdout.

// 🤐 Abstaining. Every failure here — no credential, revoked credential, service unreachable — has to
// end in the native terminal prompt rather than a broken session, so the only thing an error changes
// is a line on stderr. The alternative is a hook that can strand an agent because a laptop was
// offline, which is a worse failure than not routing the question at all.
const ABSTAIN = "{}";

export interface HookDependencies {
	baseUrl: string;
	store: CredentialStore;
	writeError: (text: string) => void;
}

export async function runHookCommand(payload: string, dependencies: HookDependencies): Promise<string> {
	let token: string;
	try {
		token = await accessToken(dependencies.baseUrl, dependencies.store);
	} catch (error) {
		dependencies.writeError(`yepnope: ${error instanceof Error ? error.message : String(error)}\n`);
		return ABSTAIN;
	}
	let response: Response;
	try {
		// No timeout by design. A permission card can sit on a phone for hours, and the request is
		// held open for exactly as long as the person takes to swipe it.
		response = await fetch(new URL("/api/v1/hook", dependencies.baseUrl), {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
			body: payload,
		});
	} catch (error) {
		dependencies.writeError(`yepnope: could not reach ${dependencies.baseUrl}: ${String(error)}\n`);
		return ABSTAIN;
	}
	if (response.status === 401) {
		dependencies.writeError(
			"yepnope: this machine's authorization was revoked or expired. Run `yepnope login` to authorize it again.\n",
		);
		return ABSTAIN;
	}
	if (!response.ok) {
		dependencies.writeError(`yepnope: the hook request failed with HTTP ${String(response.status)}.\n`);
		return ABSTAIN;
	}
	return response.text();
}
