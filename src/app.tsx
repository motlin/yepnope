import {useCallback, useEffect, useRef, useState, type ReactElement} from "react";
import {
	fetchAfk,
	issuePairingCode,
	openQuestionsStream,
	pairNew,
	submitAnswer,
	updateAfk,
	type QuestionsStream,
	type IssuedPairingCode,
} from "./api";
import {Deck, type DeckQuestion, type Disposition} from "./deck";
import {enablePush, isIos, isStandalone, updateBadge, type PushSetupResult} from "./push";
import {loadToken, saveToken} from "./token-store";

// 🌟 Harness icon placeholder: an 8-ray starburst standing in for the asking harness's logo.
function HarnessIcon(): ReactElement {
	return (
		<svg viewBox="0 0 24 24" role="img" aria-label="harness" className="harness">
			<g stroke="#d97757" strokeWidth="2.6" strokeLinecap="round">
				<line x1="12" y1="2.5" x2="12" y2="21.5" />
				<line x1="2.5" y1="12" x2="21.5" y2="12" />
				<line x1="5.3" y1="5.3" x2="18.7" y2="18.7" />
				<line x1="18.7" y1="5.3" x2="5.3" y2="18.7" />
			</g>
		</svg>
	);
}

function IosInstallHint(): ReactElement | null {
	if (!isIos() || isStandalone()) {
		return null;
	}
	// 📲 iOS only delivers web push to an installed PWA (spec §6.3).
	return (
		<div className="hint">
			<h3>Install first</h3>
			<p>
				iPhone notifications only work after the app is on your home screen: tap <b>Share</b>, then{" "}
				<b>Add to Home Screen</b>, then reopen YepNope from the icon and enable notifications.
			</p>
		</div>
	);
}

// 🧍 AFK toggle (spec §11.5): the primary flip path, prominent, effective for new questions only.
// A null state means the server has not answered yet, so the toggle reads neutral and inert.
interface AfkToggleProps {
	afk: boolean | null;
	onToggle: () => void;
}

function AfkToggle({afk, onToggle}: AfkToggleProps): ReactElement {
	const armed = afk === true;
	return (
		<button
			type="button"
			className={armed ? "afk-toggle afk-on" : "afk-toggle"}
			aria-pressed={armed}
			disabled={afk === null}
			onClick={onToggle}
		>
			{armed ? "AFK armed" : "AFK off"}
		</button>
	);
}

interface SettingsProps {
	token: string;
	onBack: () => void;
}

function Settings({token, onBack}: SettingsProps): ReactElement {
	const [pairing, setPairing] = useState<IssuedPairingCode | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
	const [isGeneratingPairing, setIsGeneratingPairing] = useState(false);
	const [pushState, setPushState] = useState<PushSetupResult | "idle" | "error">(
		"Notification" in window && Notification.permission === "granted" ? "subscribed" : "idle",
	);
	const pairingCode = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const element = pairingCode.current;
		if (pairing === null || element === null) {
			return;
		}
		const selection = window.getSelection();
		if (selection === null) {
			return;
		}
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	}, [pairing]);

	async function copyIssuedPairingCode(issued: Promise<IssuedPairingCode>): Promise<void> {
		if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
			const content = issued.then(({code}) => new Blob([code], {type: "text/plain"}));
			return navigator.clipboard.write([new ClipboardItem({"text/plain": content})]);
		}
		return issued.then(async ({code}) => navigator.clipboard.writeText(code));
	}

	async function generatePairingCode(): Promise<void> {
		setIsGeneratingPairing(true);
		const issued = issuePairingCode(token);
		const copied = copyIssuedPairingCode(issued).then(
			() => true,
			() => false,
		);
		try {
			const nextPairing = await issued;
			const copiedSuccessfully = await copied;
			setPairing(nextPairing);
			setCopyState(copiedSuccessfully ? "copied" : "error");
		} catch {
			await copied;
			setPairing(null);
			setCopyState("idle");
		} finally {
			setIsGeneratingPairing(false);
		}
	}

	async function copyPairingCode(): Promise<void> {
		if (pairing === null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(pairing.code);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	}

	return (
		<div className="settings">
			<IosInstallHint />
			<div className="hint">
				<h3>Notifications</h3>
				{pushState === "subscribed" ? (
					<p>Enabled. One notification per batch of questions.</p>
				) : (
					<>
						<p>Get one notification per batch of questions, then swipe.</p>
						<button
							type="button"
							onClick={() => {
								enablePush(token).then(setPushState, () => {
									setPushState("error");
								});
							}}
						>
							Enable notifications
						</button>
						{pushState === "denied" && <p>Notifications are blocked for this app in system settings.</p>}
						{pushState === "unsupported" && <p>This browser does not support web push.</p>}
						{pushState === "error" && <p>Could not subscribe. Try again.</p>}
					</>
				)}
			</div>
			<div className="hint">
				<h3>Pair a machine</h3>
				{copyState === "copied" && (
					<div className="copy-toast" role="status">
						📋 Copied to clipboard
					</div>
				)}
				{pairing === null ? (
					<>
						<p>Generate a code to copy it automatically, then paste it into the CLI on your machine.</p>
						<button type="button" disabled={isGeneratingPairing} onClick={() => void generatePairingCode()}>
							{isGeneratingPairing ? "Generating…" : "Generate and copy pairing code"}
						</button>
					</>
				) : (
					<>
						<div className="pairing-code-row">
							<code ref={pairingCode} className="pairing-code">
								{pairing.code}
							</code>
							<button type="button" onClick={() => void copyPairingCode()}>
								📋 Copy again
							</button>
						</div>
						<p className="copy-status" aria-live="polite">
							{copyState === "copied" && "Already copied. Paste it into your terminal."}
							{copyState === "error" && "Automatic copy was blocked. The code is selected for you."}
						</p>
						<p>The highlighted code expires in ten minutes and works once.</p>
					</>
				)}
			</div>
			<div className="hint">
				<h3>Privacy and retention</h3>
				<p>
					YepNope can read question bodies and answers. End-to-end encryption is not part of this MVP.{" "}
					Question bodies and answers are deleted seven days after each batch is created.
				</p>
			</div>
			<button type="button" className="back" onClick={onBack}>
				Back to the deck
			</button>
		</div>
	);
}

export function App(): ReactElement {
	const [token, setToken] = useState<string | null>(null);
	const [questions, setQuestions] = useState<DeckQuestion[] | null>(null);
	const [afk, setAfkState] = useState<boolean | null>(null);
	const [view, setView] = useState<"deck" | "settings">("deck");
	const questionsStream = useRef<QuestionsStream | null>(null);

	useEffect(() => {
		let cancelled = false;
		async function boot(): Promise<void> {
			const existing = loadToken();
			const minted = existing ?? (await pairNew());
			await saveToken(minted);
			if (!cancelled) {
				setToken(minted);
			}
		}
		boot().catch(() => {
			// Offline or the API is down; leave the loading state up.
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const refreshAfk = useCallback(() => {
		if (token === null) {
			return;
		}
		fetchAfk(token).then(setAfkState, () => {
			// Unknown state renders as a neutral toggle; the next refresh will retry.
		});
	}, [token]);

	useEffect(() => {
		if (token === null) {
			return undefined;
		}
		refreshAfk();
		const stream = openQuestionsStream(token, (currentQuestions) => {
			setQuestions(currentQuestions);
			updateBadge(currentQuestions.length);
		});
		questionsStream.current = stream;
		function onVisible(): void {
			if (document.visibilityState === "visible") {
				stream.refresh();
				refreshAfk();
			}
		}
		function onServiceWorkerMessage(): void {
			stream.refresh();
			refreshAfk();
		}
		document.addEventListener("visibilitychange", onVisible);
		const workerContainer = "serviceWorker" in navigator ? navigator.serviceWorker : null;
		workerContainer?.addEventListener("message", onServiceWorkerMessage);
		return () => {
			stream.close();
			if (questionsStream.current === stream) {
				questionsStream.current = null;
			}
			document.removeEventListener("visibilitychange", onVisible);
			workerContainer?.removeEventListener("message", onServiceWorkerMessage);
		};
	}, [refreshAfk, token]);

	function onAnswer(questionId: string, disposition: Disposition): void {
		if (token === null) {
			return;
		}
		setQuestions((current) => {
			const remaining = (current ?? []).filter((question) => question.questionId !== questionId);
			updateBadge(remaining.length);
			return remaining;
		});
		submitAnswer(token, questionId, disposition).catch(() => {
			questionsStream.current?.refresh();
		});
	}

	function onToggleAfk(): void {
		if (token === null || afk === null) {
			return;
		}
		const next = !afk;
		setAfkState(next);
		updateAfk(token, next).then(setAfkState, () => {
			setAfkState(afk);
		});
	}

	function currentView(): ReactElement {
		if (token === null || questions === null) {
			return <div className="loading">Connecting…</div>;
		}
		if (view === "settings") {
			return (
				<Settings
					token={token}
					onBack={() => {
						setView("deck");
					}}
				/>
			);
		}
		return <Deck questions={questions} onAnswer={onAnswer} />;
	}

	return (
		<div className="app">
			<div className="app-header">
				<span className="brand">YepNope</span>
				<span className="meta">
					<AfkToggle afk={afk} onToggle={onToggleAfk} />
					<HarnessIcon />
					<button
						type="button"
						className="settings-button"
						aria-label="Settings"
						onClick={() => {
							setView(view === "deck" ? "settings" : "deck");
						}}
					>
						&#9881;
					</button>
				</span>
			</div>
			{currentView()}
		</div>
	);
}
