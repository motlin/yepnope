import {useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent} from "react";
import {
	claimLegacyIdentity,
	fetchAccountDevices,
	fetchAfk,
	fetchPairingStatus,
	fetchSession,
	issuePairingCode,
	openCurrentDeckStream,
	registerAccount,
	requestPasswordReset,
	resetPassword,
	renameMachine,
	renamePushDevice,
	revokeMachine,
	revokePushDevice,
	sendVerificationEmail,
	signIn,
	signOut,
	submitAnswer,
	updateAfk,
	type AuthenticationUser,
	type AccountDevices,
	type CurrentDeckStream,
	type IssuedPairingCode,
	type PairingStatus,
} from "./api";
import {Deck, type DeckQuestion, type Disposition} from "./deck";
import {DEMO_QUESTIONS, isDemoQuestion} from "./demo-questions";
import {migrateLegacyIdentity} from "./legacy-token";
import {enablePush, isIos, isStandalone, updateBadge, type PushSetupResult} from "./push";

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
	signedIn: boolean;
	onPair: () => void;
	onToggle: () => void;
}

function AfkToggle({afk, paired, signedIn, onPair, onToggle}: AfkToggleProps): ReactElement {
	if (!signedIn) {
		return (
			<button type="button" className="afk-toggle" onClick={onPair}>
				Sign in to pair
			</button>
		);
	}
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
	session: AuthenticationUser | null;
	pairingStatus: PairingStatus | null;
	onBack: () => void;
	onSignIn: () => void;
	onRegister: () => void;
	onSignedOut: () => void;
	onPairingStatusChange: (status: PairingStatus) => void;
}

type AppView = "deck" | "settings" | "sign-in" | "register" | "verify-email" | "forgot-password" | "reset-password";

function viewFromPath(pathname: string): AppView {
	switch (pathname) {
		case "/settings":
			return "settings";
		case "/sign-in":
			return "sign-in";
		case "/register":
			return "register";
		case "/verify-email":
			return "verify-email";
		case "/forgot-password":
			return "forgot-password";
		case "/reset-password":
			return "reset-password";
		default:
			return "deck";
	}
}

function pathForView(view: AppView): string {
	switch (view) {
		case "settings":
			return "/settings";
		case "sign-in":
			return "/sign-in";
		case "register":
			return "/register";
		case "verify-email":
			return "/verify-email";
		case "forgot-password":
			return "/forgot-password";
		case "reset-password":
			return "/reset-password";
		case "deck":
			return "/";
	}
	return unreachableView(view);
}

function unreachableView(view: never): never {
	throw new Error(`Unknown application route: ${String(view)}`);
}

const PAIRING_STATUS_POLL_MILLISECONDS = 1_000;

interface AccountRouteProps {
	onNavigate: (view: AppView) => void;
}

interface AccountPanelProps {
	children: ReactNode;
	title: string;
}

function AccountPanel({children, title}: AccountPanelProps): ReactElement {
	return (
		<main className="account-route">
			<section className="account-panel">
				<h1>{title}</h1>
				{children}
			</section>
		</main>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

interface SignInProps extends AccountRouteProps {
	onAuthenticated: (user: AuthenticationUser) => void;
}

function SignIn({onAuthenticated, onNavigate}: SignInProps): ReactElement {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			onAuthenticated(await signIn(email, password));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<AccountPanel title="Sign in">
			<p>Sign in to recover your machines, questions, and settings on this browser.</p>
			<form className="account-form" onSubmit={(event) => void submit(event)}>
				<label>
					Email
					<input
						type="email"
						name="email"
						autoComplete="email"
						required
						value={email}
						onChange={(event) => {
							setEmail(event.currentTarget.value);
						}}
					/>
				</label>
				<label>
					Password
					<input
						type="password"
						name="password"
						autoComplete="current-password"
						required
						value={password}
						onChange={(event) => {
							setPassword(event.currentTarget.value);
						}}
					/>
				</label>
				{error !== null && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<button type="submit" disabled={submitting}>
					{submitting ? "Signing in…" : "Sign in"}
				</button>
			</form>
			<div className="account-links">
				<button
					type="button"
					onClick={() => {
						onNavigate("forgot-password");
					}}
				>
					Forgot password?
				</button>
				<button
					type="button"
					onClick={() => {
						onNavigate("register");
					}}
				>
					Create an account
				</button>
				<button
					type="button"
					onClick={() => {
						onNavigate("deck");
					}}
				>
					Back to the demo
				</button>
			</div>
		</AccountPanel>
	);
}

interface RegisterProps extends AccountRouteProps {
	onRegistered: (email: string) => void;
}

function Register({onNavigate, onRegistered}: RegisterProps): ReactElement {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			await registerAccount(name, email, password);
			onRegistered(email);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<AccountPanel title="Create an account">
			<p>Your verified email is how you recover this account on another browser.</p>
			<form className="account-form" onSubmit={(event) => void submit(event)}>
				<label>
					Name
					<input
						type="text"
						name="name"
						autoComplete="name"
						required
						value={name}
						onChange={(event) => {
							setName(event.currentTarget.value);
						}}
					/>
				</label>
				<label>
					Email
					<input
						type="email"
						name="email"
						autoComplete="email"
						required
						value={email}
						onChange={(event) => {
							setEmail(event.currentTarget.value);
						}}
					/>
				</label>
				<label>
					Password
					<input
						type="password"
						name="password"
						autoComplete="new-password"
						minLength={8}
						required
						value={password}
						onChange={(event) => {
							setPassword(event.currentTarget.value);
						}}
					/>
				</label>
				{error !== null && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<button type="submit" disabled={submitting}>
					{submitting ? "Creating account…" : "Create account"}
				</button>
			</form>
			<div className="account-links">
				<button
					type="button"
					onClick={() => {
						onNavigate("sign-in");
					}}
				>
					Already have an account?
				</button>
				<button
					type="button"
					onClick={() => {
						onNavigate("deck");
					}}
				>
					Back to the demo
				</button>
			</div>
		</AccountPanel>
	);
}

interface VerifyEmailProps extends AccountRouteProps {
	initialEmail: string;
}

function VerifyEmail({initialEmail, onNavigate}: VerifyEmailProps): ReactElement {
	const parameters = new URLSearchParams(window.location.search);
	const verified = parameters.get("verified") === "1";
	const verificationError = parameters.get("error");
	const [email, setEmail] = useState(initialEmail);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function resend(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setError(null);
		try {
			await sendVerificationEmail(email);
			setSent(true);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<AccountPanel title={verified ? "Email verified" : "Check your email"}>
			{verified ? (
				<>
					<p>Your email is verified. Sign in to continue.</p>
					<button
						type="button"
						onClick={() => {
							onNavigate("sign-in");
						}}
					>
						Sign in
					</button>
				</>
			) : (
				<>
					<p>Open the verification link we sent you. You can resend it below.</p>
					{verificationError !== null && (
						<p className="form-error" role="alert">
							That verification link is invalid or expired.
						</p>
					)}
					<form className="account-form" onSubmit={(event) => void resend(event)}>
						<label>
							Email
							<input
								type="email"
								name="email"
								autoComplete="email"
								required
								value={email}
								onChange={(event) => {
									setEmail(event.currentTarget.value);
								}}
							/>
						</label>
						{sent && (
							<p className="form-success" role="status">
								Verification email sent.
							</p>
						)}
						{error !== null && (
							<p className="form-error" role="alert">
								{error}
							</p>
						)}
						<button type="submit">Resend verification email</button>
					</form>
					<div className="account-links">
						<button
							type="button"
							onClick={() => {
								onNavigate("sign-in");
							}}
						>
							Back to sign in
						</button>
					</div>
				</>
			)}
		</AccountPanel>
	);
}

function ForgotPassword({onNavigate}: AccountRouteProps): ReactElement {
	const [email, setEmail] = useState("");
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setError(null);
		try {
			await requestPasswordReset(email);
			setSent(true);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<AccountPanel title="Reset your password">
			<p>We’ll email a recovery link if an account exists for this address.</p>
			<form className="account-form" onSubmit={(event) => void submit(event)}>
				<label>
					Email
					<input
						type="email"
						name="email"
						autoComplete="email"
						required
						value={email}
						onChange={(event) => {
							setEmail(event.currentTarget.value);
						}}
					/>
				</label>
				{sent && (
					<p className="form-success" role="status">
						Check your email for a recovery link.
					</p>
				)}
				{error !== null && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<button type="submit">Send recovery email</button>
			</form>
			<div className="account-links">
				<button
					type="button"
					onClick={() => {
						onNavigate("sign-in");
					}}
				>
					Back to sign in
				</button>
			</div>
		</AccountPanel>
	);
}

function ResetPassword({onNavigate}: AccountRouteProps): ReactElement {
	const parameters = new URLSearchParams(window.location.search);
	const token = parameters.get("token");
	const invalid = parameters.get("error") !== null || token === null;
	const [password, setPassword] = useState("");
	const [reset, setReset] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		if (token === null) {
			return;
		}
		setError(null);
		try {
			await resetPassword(token, password);
			setReset(true);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<AccountPanel title="Choose a new password">
			{invalid ? (
				<>
					<p className="form-error" role="alert">
						This recovery link is invalid or expired.
					</p>
					<button
						type="button"
						onClick={() => {
							onNavigate("forgot-password");
						}}
					>
						Request another link
					</button>
				</>
			) : reset ? (
				<>
					<p className="form-success" role="status">
						Your password has been changed.
					</p>
					<button
						type="button"
						onClick={() => {
							onNavigate("sign-in");
						}}
					>
						Sign in
					</button>
				</>
			) : (
				<form className="account-form" onSubmit={(event) => void submit(event)}>
					<label>
						New password
						<input
							type="password"
							name="password"
							autoComplete="new-password"
							minLength={8}
							required
							value={password}
							onChange={(event) => {
								setPassword(event.currentTarget.value);
							}}
						/>
					</label>
					{error !== null && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<button type="submit">Save new password</button>
				</form>
			)}
		</AccountPanel>
	);
}

interface ManagedDeviceRowProps {
	createdAt: number;
	label: string;
	lastUsedText: string;
	onRename: (label: string) => Promise<void>;
	onRevoke: () => Promise<void>;
}

function ManagedDeviceRow({createdAt, label, lastUsedText, onRename, onRevoke}: ManagedDeviceRowProps): ReactElement {
	const [editing, setEditing] = useState(false);
	const [nextLabel, setNextLabel] = useState(label);
	const [busy, setBusy] = useState(false);

	async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setBusy(true);
		try {
			await onRename(nextLabel);
			setEditing(false);
		} finally {
			setBusy(false);
		}
	}

	return (
		<li className="managed-device">
			{editing ? (
				<form className="device-rename" onSubmit={(event) => void save(event)}>
					<label>
						Device name
						<input
							type="text"
							maxLength={100}
							required
							value={nextLabel}
							onChange={(event) => {
								setNextLabel(event.currentTarget.value);
							}}
						/>
					</label>
					<div className="device-actions">
						<button type="submit" disabled={busy}>
							Save
						</button>
						<button
							type="button"
							className="secondary"
							disabled={busy}
							onClick={() => {
								setNextLabel(label);
								setEditing(false);
							}}
						>
							Cancel
						</button>
					</div>
				</form>
			) : (
				<>
					<div>
						<strong>{label}</strong>
						<small>
							Added {new Date(createdAt).toLocaleString()} · {lastUsedText}
						</small>
					</div>
					<div className="device-actions">
						<button
							type="button"
							className="secondary"
							onClick={() => {
								setEditing(true);
							}}
						>
							Rename
						</button>
						<button
							type="button"
							className="danger"
							disabled={busy}
							onClick={() => {
								setBusy(true);
								void onRevoke().finally(() => {
									setBusy(false);
								});
							}}
						>
							Revoke
						</button>
					</div>
				</>
			)}
		</li>
	);
}

function Settings({
	session,
	pairingStatus,
	onBack,
	onSignIn,
	onRegister,
	onSignedOut,
	onPairingStatusChange,
}: SettingsProps): ReactElement {
	const requiresIosInstall = isIos() && !isStandalone();
	const [pairing, setPairing] = useState<IssuedPairingCode | null>(null);
	const [pairingBaseline, setPairingBaseline] = useState<number | null>(null);
	const [pairingOutcome, setPairingOutcome] = useState<"paired" | "expired" | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
	const [isGeneratingPairing, setIsGeneratingPairing] = useState(false);
	const [accountError, setAccountError] = useState<string | null>(null);
	const [accountDevices, setAccountDevices] = useState<AccountDevices | null>(null);
	const [devicesError, setDevicesError] = useState<string | null>(null);
	const [pushState, setPushState] = useState<PushSetupResult | "idle" | "error">(
		"Notification" in window && Notification.permission === "granted" ? "subscribed" : "idle",
	);
	const pairingCode = useRef<HTMLElement | null>(null);

	const reloadDevices = useCallback(async (): Promise<void> => {
		if (session === null) {
			setAccountDevices(null);
			return;
		}
		try {
			setAccountDevices(await fetchAccountDevices());
			setDevicesError(null);
		} catch (caught) {
			setDevicesError(errorMessage(caught));
		}
	}, [session]);

	useEffect(() => {
		void reloadDevices();
	}, [reloadDevices]);

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
		if (session === null || pairing === null || pairingBaseline === null) {
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
				const status = await fetchPairingStatus();
				if (cancelled) {
					return;
				}
				onPairingStatusChange(status);
				if (status.machineCount > baseline) {
					setPairing(null);
					setPairingBaseline(null);
					setPairingOutcome("paired");
					setCopyState("idle");
					void reloadDevices();
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
	}, [onPairingStatusChange, pairing, pairingBaseline, reloadDevices, session]);

	async function runDeviceAction(action: () => Promise<void>): Promise<void> {
		setDevicesError(null);
		try {
			await action();
			await reloadDevices();
		} catch (caught) {
			setDevicesError(errorMessage(caught));
		}
	}

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
		const currentStatus = fetchPairingStatus();
		const issued = issuePairingCode();
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
			<div className="hint account-summary">
				<h3>Account</h3>
				{session === null ? (
					<>
						<p>
							Sign in to pair machines, receive live questions, and recover your account on another
							browser.
						</p>
						<div className="settings-actions">
							<button type="button" onClick={onSignIn}>
								Sign in
							</button>
							<button type="button" className="secondary" onClick={onRegister}>
								Create account
							</button>
						</div>
					</>
				) : (
					<>
						<p className="account-email">{session.email}</p>
						<p>✓ Verified email · Session active</p>
						<button
							type="button"
							className="secondary"
							onClick={() => {
								setAccountError(null);
								void signOut().then(onSignedOut, (caught: unknown) => {
									setAccountError(errorMessage(caught));
								});
							}}
						>
							Sign out
						</button>
						{accountError !== null && (
							<p className="form-error" role="alert">
								{accountError}
							</p>
						)}
					</>
				)}
			</div>
			<IosInstallHint required={requiresIosInstall} />
			<div className="hint">
				<h3>Notifications</h3>
				{session === null ? (
					<>
						<p>Sign in before enabling notifications.</p>
						<button type="button" onClick={onSignIn}>
							Sign in
						</button>
					</>
				) : requiresIosInstall ? (
					<p>Available after you open the installed Home Screen app.</p>
				) : pushState === "subscribed" ? (
					<p>Enabled. One notification per batch of questions.</p>
				) : (
					<>
						<p>Get one notification per batch of questions, then swipe.</p>
						<button
							type="button"
							onClick={() => {
								void enablePush().then(
									(result) => {
										setPushState(result);
										if (result === "subscribed") {
											void reloadDevices();
										}
									},
									() => {
										setPushState("error");
									},
								);
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
			{session !== null && (
				<div className="hint">
					<h3>Devices</h3>
					<p>Rename devices you recognize and revoke credentials you no longer use.</p>
					<h4>Paired machines</h4>
					{accountDevices === null ? (
						<p>Loading devices…</p>
					) : accountDevices.machines.length === 0 ? (
						<p>No paired machines.</p>
					) : (
						<ul className="device-list">
							{accountDevices.machines.map((machine) => (
								<ManagedDeviceRow
									key={machine.id}
									createdAt={machine.createdAt}
									label={machine.label}
									lastUsedText={
										machine.lastUsedAt === null
											? "Never used"
											: `Last used ${new Date(machine.lastUsedAt).toLocaleString()}`
									}
									onRename={async (label) =>
										runDeviceAction(async () => renameMachine(machine.id, label))
									}
									onRevoke={async () =>
										runDeviceAction(async () => {
											onPairingStatusChange(await revokeMachine(machine.id));
										})
									}
								/>
							))}
						</ul>
					)}
					<h4>Browser notifications</h4>
					{accountDevices !== null && accountDevices.pushDevices.length === 0 ? (
						<p>No browsers receive notifications.</p>
					) : (
						<ul className="device-list">
							{accountDevices?.pushDevices.map((device) => (
								<ManagedDeviceRow
									key={device.id}
									createdAt={device.createdAt}
									label={device.label}
									lastUsedText="Receives push notifications"
									onRename={async (label) =>
										runDeviceAction(async () => renamePushDevice(device.id, label))
									}
									onRevoke={async () => runDeviceAction(async () => revokePushDevice(device.id))}
								/>
							))}
						</ul>
					)}
					{devicesError !== null && (
						<p className="form-error" role="alert">
							{devicesError}
						</p>
					)}
				</div>
			)}
			<div className="hint">
				<h3>{pairingStatus?.paired === true ? "Pair another machine" : "Pair a machine"}</h3>
				{session === null ? (
					<>
						<p>Pairing belongs to your account, so you need to sign in first.</p>
						<button type="button" onClick={onSignIn}>
							Sign in to pair
						</button>
					</>
				) : requiresIosInstall ? (
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
				{session === null || requiresIosInstall ? null : pairing === null ? (
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
					Question bodies and current answers are deleted seven days after each batch is created. Activity
					outcomes are kept so your history totals remain explainable.
				</p>
			</div>
			<button type="button" className="back" onClick={onBack}>
				Back to the deck
			</button>
		</div>
	);
}

export function App(): ReactElement {
	const [session, setSession] = useState<AuthenticationUser | null>(null);
	const [sessionReady, setSessionReady] = useState(false);
	const [currentQuestions, setCurrentQuestions] = useState<DeckQuestion[]>([]);
	const [afk, setAfkState] = useState<boolean | null>(null);
	const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
	const [demoQuestions, setDemoQuestions] = useState<DeckQuestion[]>(() => [...DEMO_QUESTIONS]);
	const [view, setView] = useState<AppView>(() => viewFromPath(window.location.pathname));
	const [registrationEmail, setRegistrationEmail] = useState("");
	const currentDeckStream = useRef<CurrentDeckStream | null>(null);

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
		const titles: Record<AppView, string> = {
			deck: "YepNope",
			settings: "Settings · YepNope",
			"sign-in": "Sign in · YepNope",
			register: "Create account · YepNope",
			"verify-email": "Verify email · YepNope",
			"forgot-password": "Reset password · YepNope",
			"reset-password": "Choose a password · YepNope",
		};
		document.title = titles[view];
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
		fetchSession().then(
			(user) => {
				if (!cancelled) {
					setSession(user);
					setSessionReady(true);
				}
			},
			() => {
				if (!cancelled) {
					setSession(null);
					setSessionReady(true);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	const refreshAfk = useCallback(() => {
		if (session === null) {
			return;
		}
		fetchAfk().then(setAfkState, () => {
			// Unknown state renders as a neutral toggle; the next refresh will retry.
		});
	}, [session]);

	const refreshPairingStatus = useCallback(() => {
		if (session === null) {
			return;
		}
		fetchPairingStatus().then(setPairingStatus, () => {
			// Keep the last known pairing state and retry on the next refresh.
		});
	}, [session]);

	useEffect(() => {
		if (session === null) {
			return;
		}
		migrateLegacyIdentity(claimLegacyIdentity).then(
			(claimed) => {
				if (!claimed) {
					return;
				}
				refreshAfk();
				refreshPairingStatus();
				currentDeckStream.current?.refresh();
			},
			() => {
				// Keep the credential so the signed-in user can retry the explicit claim.
			},
		);
	}, [refreshAfk, refreshPairingStatus, session]);

	useEffect(() => {
		if (session === null) {
			setCurrentQuestions([]);
			setAfkState(null);
			setPairingStatus(null);
			updateBadge(0);
			return undefined;
		}
		refreshAfk();
		refreshPairingStatus();
		const stream = openCurrentDeckStream((state) => {
			setAfkState(state.afk);
			setPairingStatus(state.pairingStatus);
			setCurrentQuestions(state.currentDeck);
			updateBadge(state.currentDeck.length);
		});
		currentDeckStream.current = stream;
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
			if (currentDeckStream.current === stream) {
				currentDeckStream.current = null;
			}
			document.removeEventListener("visibilitychange", onVisible);
			workerContainer?.removeEventListener("message", onServiceWorkerMessage);
		};
	}, [refreshAfk, refreshPairingStatus, session]);

	function onAnswer(questionId: string, disposition: Disposition): void {
		if (isDemoQuestion(questionId)) {
			setDemoQuestions((current) => current.filter((question) => question.questionId !== questionId));
			return;
		}
		if (session === null) {
			return;
		}
		setCurrentQuestions((current) => {
			const remaining = current.filter((question) => question.questionId !== questionId);
			updateBadge(remaining.length);
			return remaining;
		});
		submitAnswer(questionId, disposition).catch(() => {
			currentDeckStream.current?.refresh();
		});
	}

	function onToggleAfk(): void {
		if (session === null || afk === null) {
			return;
		}
		const next = !afk;
		setAfkState(next);
		updateAfk(next).then(setAfkState, () => {
			setAfkState(afk);
		});
	}

	function currentView(): ReactElement {
		switch (view) {
			case "settings":
				if (!sessionReady) {
					return <div className="loading">Checking your session…</div>;
				}
				return (
					<Settings
						session={session}
						pairingStatus={pairingStatus}
						onBack={() => {
							navigate("deck");
						}}
						onSignIn={() => {
							navigate("sign-in");
						}}
						onRegister={() => {
							navigate("register");
						}}
						onSignedOut={() => {
							setSession(null);
							navigate("deck");
						}}
						onPairingStatusChange={setPairingStatus}
					/>
				);
			case "sign-in":
				return (
					<SignIn
						onNavigate={navigate}
						onAuthenticated={(user) => {
							setSession(user);
							setSessionReady(true);
							navigate("settings");
						}}
					/>
				);
			case "register":
				return (
					<Register
						onNavigate={navigate}
						onRegistered={(email) => {
							setRegistrationEmail(email);
							navigate("verify-email");
						}}
					/>
				);
			case "verify-email":
				return <VerifyEmail initialEmail={registrationEmail} onNavigate={navigate} />;
			case "forgot-password":
				return <ForgotPassword onNavigate={navigate} />;
			case "reset-password":
				return <ResetPassword onNavigate={navigate} />;
			case "deck":
				return (
					<Deck
						questions={currentQuestions.length === 0 ? demoQuestions : currentQuestions}
						onAnswer={onAnswer}
					/>
				);
		}
		return unreachableView(view);
	}

	return (
		<div className="app">
			<div className="app-header">
				<span className="meta">
					<AfkToggle
						afk={afk}
						paired={pairingStatus?.paired ?? null}
						signedIn={session !== null}
						onPair={() => {
							navigate(session === null ? "sign-in" : "settings");
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
