import {useCallback, useEffect, useRef, useState, type ReactElement} from "react";
import {
	fetchAfk,
	fetchPairingStatus,
	issuePairingCode,
	openQuestionsStream,
	pairNew,
	submitAnswer,
	updateAfk,
	type QuestionsStream,
	type IssuedPairingCode,
	type PairingStatus,
} from "./api";
import {Deck, type DeckQuestion, type Disposition} from "./deck";
import {DEMO_QUESTIONS, isDemoQuestion} from "./demo-questions";
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

interface IosInstallHintProps {
	required: boolean;
}

function IosInstallHint({required}: IosInstallHintProps): ReactElement | null {
	if (!required) {
		return null;
	}
	// 📲 iOS only delivers web push to an installed PWA (spec §6.3).
	return (
		<div className="hint">
			<h3>Install first</h3>
			<p>
				On iPhone, tap <b>Share</b>, choose <b>Add to Home Screen</b>, leave <b>Open as Web App</b> on, then
				open YepNope from its Home Screen icon.
			</p>
		</div>
	);
}

// 🧍 AFK toggle (spec §11.5): the primary flip path, prominent, effective for new questions only.
// A null state means the server has not answered yet, so the toggle reads neutral and inert.
interface AfkToggleProps {
	afk: boolean | null;
	paired: boolean | null;
	onPair: () => void;
	onToggle: () => void;
}

function AfkToggle({afk, paired, onPair, onToggle}: AfkToggleProps): ReactElement {
	if (paired !== true) {
		return (
			<button type="button" className="afk-toggle" disabled={paired === null} onClick={onPair}>
				{paired === null ? "Checking…" : "Pair a machine"}
			</button>
		);
	}
	const enabled = afk === true;
	return (
		<button
			type="button"
			className={enabled ? "afk-toggle afk-on" : "afk-toggle"}
			aria-pressed={enabled}
			disabled={afk === null}
			onClick={onToggle}
		>
			{enabled ? "AFK on" : "AFK off"}
		</button>
	);
}

interface SettingsProps {
	token: string;
	pairingStatus: PairingStatus | null;
	onBack: () => void;
	onPairingStatusChange: (status: PairingStatus) => void;
}

type AppView = "deck" | "settings";

function viewFromPath(pathname: string): AppView {
	return pathname === "/settings" ? "settings" : "deck";
}

function pathForView(view: AppView): string {
	return view === "settings" ? "/settings" : "/";
}

const PAIRING_STATUS_POLL_MILLISECONDS = 1_000;

function Settings({token, pairingStatus, onBack, onPairingStatusChange}: SettingsProps): ReactElement {
	const requiresIosInstall = isIos() && !isStandalone();
	const [pairing, setPairing] = useState<IssuedPairingCode | null>(null);
	const [pairingBaseline, setPairingBaseline] = useState<number | null>(null);
	const [pairingOutcome, setPairingOutcome] = useState<"paired" | "expired" | null>(null);
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

	useEffect(() => {
		if (pairing === null || pairingBaseline === null) {
			return undefined;
		}
		const pendingPairing = pairing;
		const baseline = pairingBaseline;
		let cancelled = false;
		let checking = false;
		async function checkPairing(): Promise<void> {
			if (checking) {
				return;
			}
			checking = true;
			try {
				const status = await fetchPairingStatus(token);
				if (cancelled) {
					return;
				}
				onPairingStatusChange(status);
				if (status.machineCount > baseline) {
					setPairing(null);
					setPairingBaseline(null);
					setPairingOutcome("paired");
					setCopyState("idle");
				} else if (Date.now() >= pendingPairing.expiresAt) {
					setPairing(null);
					setPairingBaseline(null);
					setPairingOutcome("expired");
					setCopyState("idle");
				}
			} catch {
				// A later poll retries transient status failures while the code remains valid.
			} finally {
				checking = false;
			}
		}
		const timer = window.setInterval(() => void checkPairing(), PAIRING_STATUS_POLL_MILLISECONDS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [onPairingStatusChange, pairing, pairingBaseline, token]);

	async function copyIssuedPairingCode(issued: Promise<IssuedPairingCode>): Promise<void> {
		if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
			const content = issued.then(({code}) => new Blob([code], {type: "text/plain"}));
			return navigator.clipboard.write([new ClipboardItem({"text/plain": content})]);
		}
		return issued.then(async ({code}) => navigator.clipboard.writeText(code));
	}

	async function generatePairingCode(): Promise<void> {
		setIsGeneratingPairing(true);
		setPairingOutcome(null);
		const currentStatus = fetchPairingStatus(token);
		const issued = issuePairingCode(token);
		const copied = copyIssuedPairingCode(issued).then(
			() => true,
			() => false,
		);
		try {
			const [nextPairing, copiedSuccessfully, status] = await Promise.all([issued, copied, currentStatus]);
			onPairingStatusChange(status);
			setPairingBaseline(status.machineCount);
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
			<IosInstallHint required={requiresIosInstall} />
			<div className="hint">
				<h3>Notifications</h3>
				{requiresIosInstall ? (
					<p>Available after you open the installed Home Screen app.</p>
				) : pushState === "subscribed" ? (
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
				<h3>{pairingStatus?.paired === true ? "Pair another machine" : "Pair a machine"}</h3>
				{requiresIosInstall ? (
					<p>
						Install first, then generate the code from the Home Screen app so pairing and notifications use
						the same app identity.
					</p>
				) : pairingOutcome === "paired" ? (
					<div className="copy-toast" role="status">
						✓ Machine paired
					</div>
				) : copyState === "copied" ? (
					<div className="copy-toast" role="status">
						📋 Copied to clipboard
					</div>
				) : null}
				{requiresIosInstall ? null : pairing === null ? (
					<>
						<p>
							{pairingOutcome === "expired"
								? "That code expired. Generate a new one to try again."
								: pairingStatus?.paired === true
									? "This app is paired. Generate another code to connect another machine."
									: "Generate a code to copy it automatically, then paste it into the CLI on your machine."}
						</p>
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
	const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
	const [demoQuestions, setDemoQuestions] = useState<DeckQuestion[]>(() => [...DEMO_QUESTIONS]);
	const [view, setView] = useState<AppView>(() => viewFromPath(window.location.pathname));
	const questionsStream = useRef<QuestionsStream | null>(null);

	useEffect(() => {
		function onPopState(): void {
			setView(viewFromPath(window.location.pathname));
		}
		window.addEventListener("popstate", onPopState);
		return () => {
			window.removeEventListener("popstate", onPopState);
		};
	}, []);

	useEffect(() => {
		document.title = view === "settings" ? "Settings · YepNope" : "YepNope";
	}, [view]);

	function navigate(nextView: AppView): void {
		const path = pathForView(nextView);
		if (window.location.pathname !== path) {
			window.history.pushState({}, "", path);
		}
		setView(nextView);
	}

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

	const refreshPairingStatus = useCallback(() => {
		if (token === null) {
			return;
		}
		fetchPairingStatus(token).then(setPairingStatus, () => {
			// Keep the last known pairing state and retry on the next refresh.
		});
	}, [token]);

	useEffect(() => {
		if (token === null) {
			return undefined;
		}
		refreshAfk();
		refreshPairingStatus();
		const stream = openQuestionsStream(token, (currentQuestions) => {
			setQuestions(currentQuestions);
			updateBadge(currentQuestions.length);
		});
		questionsStream.current = stream;
		function onVisible(): void {
			if (document.visibilityState === "visible") {
				stream.refresh();
				refreshAfk();
				refreshPairingStatus();
			}
		}
		function onServiceWorkerMessage(): void {
			stream.refresh();
			refreshAfk();
			refreshPairingStatus();
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
	}, [refreshAfk, refreshPairingStatus, token]);

	function onAnswer(questionId: string, disposition: Disposition): void {
		if (isDemoQuestion(questionId)) {
			setDemoQuestions((current) => current.filter((question) => question.questionId !== questionId));
			return;
		}
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
					pairingStatus={pairingStatus}
					onBack={() => {
						navigate("deck");
					}}
					onPairingStatusChange={setPairingStatus}
				/>
			);
		}
		return <Deck questions={questions.length === 0 ? demoQuestions : questions} onAnswer={onAnswer} />;
	}

	return (
		<div className="app">
			<div className="app-header">
				<span className="meta">
					<AfkToggle
						afk={afk}
						paired={pairingStatus?.paired ?? null}
						onPair={() => {
							navigate("settings");
						}}
						onToggle={onToggleAfk}
					/>
					<HarnessIcon />
					<button
						type="button"
						className="settings-button"
						aria-label={view === "settings" ? "Close settings" : "Settings"}
						onClick={() => {
							navigate(view === "deck" ? "settings" : "deck");
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
