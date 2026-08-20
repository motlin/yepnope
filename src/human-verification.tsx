import type {ReactElement} from "react";
import {HUMAN_VERIFICATION_FAILED_MESSAGE, type HumanVerification, type HumanVerificationStatus} from "./turnstile";

// 🤖 The visible half of human verification. `src/turnstile.ts` holds the widget itself and the
// token it mints; this file is only how that work reads to the person waiting on it.

const HUMAN_VERIFICATION_COPY: Readonly<Record<HumanVerificationStatus, string>> = {
	expired: "That check expired. Running it again…",
	failed: HUMAN_VERIFICATION_FAILED_MESSAGE,
	loading: "Loading the human-verification check…",
	ready: "Human verification complete.",
	solving: "Checking that you are human…",
	waived: "",
};

interface HumanVerificationFieldProps {
	verification: HumanVerification;
}

/**
 * The visible check. It occupies the same column as the inputs above it, announces each state
 * change politely rather than interrupting, and offers a keyboard-reachable retry when the check
 * cannot finish on its own.
 */
export function HumanVerificationField({verification}: HumanVerificationFieldProps): ReactElement | null {
	if (verification.status === "waived") {
		return null;
	}
	const failed = verification.status === "failed";
	return (
		<div className="human-verification" role="group" aria-label="Human verification">
			<div className="human-verification-widget" ref={verification.container} />
			{/* Progress is announced politely; a check that cannot finish interrupts, because the
			    visitor is otherwise left looking at a submit button that will not respond. */}
			<p
				className={failed ? "form-error" : "human-verification-status"}
				role={failed ? "alert" : "status"}
				aria-live={failed ? "assertive" : "polite"}
				aria-busy={verification.status === "loading" || verification.status === "solving" || undefined}
			>
				{HUMAN_VERIFICATION_COPY[verification.status]}
			</p>
			{failed && (
				<button type="button" className="secondary" onClick={verification.retry}>
					Retry verification
				</button>
			)}
			<p className="human-verification-disclosure">
				Cloudflare Turnstile checks this browser so automated sign-ups cannot flood the service. It never
				receives your password.{" "}
				<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noreferrer">
					Privacy Policy
				</a>{" "}
				and{" "}
				<a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noreferrer">
					Terms
				</a>
				.
			</p>
		</div>
	);
}
