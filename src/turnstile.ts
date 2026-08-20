import {useCallback, useEffect, useRef, useState} from "react";
import type {ResolvedTheme} from "./theme";

// 🤖 The browser half of human verification. It draws Cloudflare's Turnstile widget on the
// signed-out authentication pages and hands each request the token the widget minted. It proves
// nothing on its own — `worker/turnstile.ts` redeems every token with Cloudflare before it does any
// account work — so this file's whole job is to make the wait legible and the failure recoverable.
// The visible field that reports the states below lives in `src/human-verification.tsx`.

const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_TIMEOUT_MILLISECONDS = 15_000;
const TOKEN_TIMEOUT_MILLISECONDS = 30_000;

export const HUMAN_VERIFICATION_FAILED_MESSAGE =
	"We could not verify this browser. Retry the check below, then submit again.";

interface TurnstileRenderOptions {
	action: string;
	appearance: "always";
	callback: (token: string) => void;
	"error-callback": () => void;
	"expired-callback": () => void;
	"refresh-expired": "auto";
	retry: "never";
	sitekey: string;
	size: "flexible";
	theme: ResolvedTheme;
	"timeout-callback": () => void;
}

interface TurnstileApi {
	remove: (widgetId: string) => void;
	render: (container: HTMLElement, options: TurnstileRenderOptions) => string | undefined;
	reset: (widgetId: string) => void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

/** Thrown when the widget cannot produce a token, so a form can explain itself instead of hanging. */
class HumanVerificationError extends Error {
	constructor() {
		super(HUMAN_VERIFICATION_FAILED_MESSAGE);
		this.name = "HumanVerificationError";
	}
}

let scriptLoad: Promise<TurnstileApi> | null = null;

/**
 * Loads Cloudflare's widget script once per page. A failed load is not cached, so the retry control
 * gets a real second attempt rather than the first attempt's rejection replayed.
 */
async function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile !== undefined) {
		return window.turnstile;
	}
	scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		const timeout = window.setTimeout(() => {
			reject(new HumanVerificationError());
		}, SCRIPT_TIMEOUT_MILLISECONDS);
		const settle = (): void => {
			window.clearTimeout(timeout);
			if (window.turnstile === undefined) {
				reject(new HumanVerificationError());
				return;
			}
			resolve(window.turnstile);
		};
		script.addEventListener("load", settle);
		script.addEventListener("error", () => {
			window.clearTimeout(timeout);
			reject(new HumanVerificationError());
		});
		script.async = true;
		script.defer = true;
		script.src = TURNSTILE_SCRIPT_URL;
		document.head.append(script);
	}).catch((caught: unknown) => {
		scriptLoad = null;
		throw caught;
	});
	return scriptLoad;
}

export type HumanVerificationStatus =
	// This deployment configured no widget, so nothing is drawn and nothing is sent.
	"waived" | "loading" | "solving" | "ready" | "expired" | "failed";

export interface HumanVerification {
	/**
	 * The token for the next request, waiting for the widget if it is still working. Returns null
	 * only when the deployment waived verification, and throws when the check cannot be completed.
	 */
	consume: () => Promise<string | null>;
	/**
	 * A callback ref rather than a stored one. The site key arrives from the Worker after the first
	 * render, so the element the widget draws into does not exist yet when the hook first runs; the
	 * callback is what tells the hook the element has finally arrived.
	 */
	container: (node: HTMLDivElement | null) => void;
	retry: () => void;
	status: HumanVerificationStatus;
}

interface TokenWaiter {
	reject: () => void;
	resolve: (token: string) => void;
}

/**
 * One widget, one surface. `action` names the surface in the minted token so the Worker can refuse
 * a token that was earned somewhere else.
 */
export function useHumanVerification(action: string, siteKey: string | null, theme: ResolvedTheme): HumanVerification {
	const widgetId = useRef<string | null>(null);
	const heldToken = useRef<string | null>(null);
	const waiters = useRef<TokenWaiter[]>([]);
	const [attempt, setAttempt] = useState(0);
	const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
	const [status, setStatus] = useState<HumanVerificationStatus>(siteKey === null ? "waived" : "loading");

	const container = useCallback((node: HTMLDivElement | null) => {
		setContainerNode(node);
	}, []);

	useEffect(() => {
		// The widget cannot produce a token: drop anything held, refuse everything waiting, and let
		// the field offer the retry that starts a fresh attempt.
		const failVerification = (): void => {
			const pending = waiters.current;
			heldToken.current = null;
			waiters.current = [];
			for (const waiter of pending) {
				waiter.reject();
			}
			setStatus("failed");
		};
		let abandoned = false;
		let rendered: string | null = null;
		// The site key arrives from the Worker one render late, and the element to draw into arrives
		// one render after that. Both absences are ordinary waiting rather than failure.
		if (siteKey === null) {
			setStatus("waived");
		} else if (containerNode === null) {
			setStatus("loading");
		} else {
			void loadTurnstile().then(
				(turnstile) => {
					if (abandoned) {
						return;
					}
					setStatus("solving");
					rendered =
						turnstile.render(containerNode, {
							action,
							// The visitor should see that a check is happening rather than discover it
							// only when an interactive challenge suddenly appears.
							appearance: "always",
							callback: (token) => {
								const waiter = waiters.current.shift();
								if (waiter === undefined) {
									heldToken.current = token;
									setStatus("ready");
									return;
								}
								// 🎟️ A token is redeemable exactly once. Handing this one to a waiting
								// request means the widget must start earning the next one immediately.
								heldToken.current = null;
								waiter.resolve(token);
								setStatus("solving");
								if (rendered !== null) {
									turnstile.reset(rendered);
								}
							},
							"error-callback": failVerification,
							"expired-callback": () => {
								heldToken.current = null;
								setStatus("expired");
							},
							// An unredeemed token that ages out is replaced without the visitor asking.
							"refresh-expired": "auto",
							// A silent retry loop reads as a hung page; a stated failure can be retried.
							retry: "never",
							sitekey: siteKey,
							size: "flexible",
							theme,
							"timeout-callback": failVerification,
						}) ?? null;
					widgetId.current = rendered;
				},
				() => {
					if (!abandoned) {
						failVerification();
					}
				},
			);
		}
		return () => {
			abandoned = true;
			heldToken.current = null;
			widgetId.current = null;
			if (rendered !== null) {
				window.turnstile?.remove(rendered);
			}
		};
		// A repainted page needs a repainted widget, so the theme joins the keys that redraw it.
	}, [action, attempt, containerNode, siteKey, theme]);

	const consume = useCallback(async (): Promise<string | null> => {
		if (siteKey === null) {
			return null;
		}
		const held = heldToken.current;
		if (held !== null) {
			heldToken.current = null;
			setStatus("solving");
			if (widgetId.current !== null) {
				window.turnstile?.reset(widgetId.current);
			}
			return held;
		}
		return new Promise<string>((resolve, reject) => {
			const waiter: TokenWaiter = {
				reject: () => {
					window.clearTimeout(timeout);
					reject(new HumanVerificationError());
				},
				resolve: (token) => {
					window.clearTimeout(timeout);
					resolve(token);
				},
			};
			const timeout = window.setTimeout(() => {
				waiters.current = waiters.current.filter((candidate) => candidate !== waiter);
				setStatus("failed");
				reject(new HumanVerificationError());
			}, TOKEN_TIMEOUT_MILLISECONDS);
			waiters.current.push(waiter);
		});
	}, [siteKey]);

	const retry = useCallback(() => {
		setAttempt((previous) => previous + 1);
	}, []);

	return {consume, container, retry, status};
}

/** A submit control stays inert until the check behind it has actually produced something to send. */
export function humanVerificationBlocksSubmit(verification: HumanVerification): boolean {
	return verification.status !== "waived" && verification.status !== "ready";
}
