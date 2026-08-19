import {useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent} from "react";
import {
	claimLegacyIdentity,
	consumePasswordResetToken,
	fetchAccountDevices,
	fetchAfk,
	fetchOAuthClient,
	fetchSession,
	openCurrentDeckStream,
	registerAccount,
	requestPasswordReset,
	resumeOAuthAuthorization,
	renamePushDevice,
	revokeConnectedMcpClient,
	revokePushDevice,
	sendVerificationEmail,
	signIn,
	signInForOAuth,
	signOut,
	submitAnswer,
	submitOAuthConsent,
	updateAfk,
	ApiResponseError,
	type AuthenticationUser,
	type AccountDevices,
	type CurrentDeckStream,
	type OAuthClientSummary,
} from "./api";
import {Deck, type DeckQuestion, type Disposition} from "./deck";
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

// 🧍 AFK is available only while an OAuth-authorized MCP host or CLI installation is active.
interface AfkToggleProps {
	afk: boolean | null;
	connectedMcpClientCount: number | null;
	onOpenSettings: () => void;
	onToggle: () => void;
}

function AfkToggle({afk, connectedMcpClientCount, onOpenSettings, onToggle}: AfkToggleProps): ReactElement {
	if (connectedMcpClientCount === null) {
		return (
			<button type="button" className="account-status" disabled>
				Checking account…
			</button>
		);
	}
	const clientLabel =
		connectedMcpClientCount === 1 ? "1 MCP client authorized" : `${connectedMcpClientCount} MCP clients authorized`;
	if (connectedMcpClientCount === 0) {
		return (
			<button type="button" className="account-status" onClick={onOpenSettings}>
				Connect an MCP client
			</button>
		);
	}
	const checking = afk === null;
	const enabled = afk === true;
	const afkClassName = checking ? "afk-toggle afk-checking" : enabled ? "afk-toggle afk-on" : "afk-toggle afk-off";
	return (
		<>
			<button type="button" className="account-status" onClick={onOpenSettings}>
				{clientLabel}
			</button>
			<button
				type="button"
				className={afkClassName}
				aria-busy={checking || undefined}
				aria-pressed={checking ? undefined : enabled}
				disabled={checking}
				onClick={onToggle}
			>
				{checking ? "Checking AFK…" : enabled ? "AFK on" : "AFK off"}
			</button>
		</>
	);
}

interface SettingsProps {
	session: AuthenticationUser | null;
	connectedMcpClientCount: number | null;
	onBack: () => void;
	onSignIn: () => void;
	onRegister: () => void;
	onSignedOut: () => void;
}

type AppView =
	| "deck"
	| "settings"
	| "sign-in"
	| "register"
	| "verify-email"
	| "forgot-password"
	| "reset-password"
	| "oauth-consent";

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
		case "/oauth/consent":
			return "oauth-consent";
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
		case "oauth-consent":
			return "/oauth/consent";
		case "deck":
			return "/";
	}
	return unreachableView(view);
}

function unreachableView(view: never): never {
	throw new Error(`Unknown application route: ${String(view)}`);
}

function oauthQueryFromLocation(): string | null {
	const parameters = new URLSearchParams(window.location.search);
	if (window.location.pathname === "/reset-password" && (parameters.has("token") || parameters.has("error"))) {
		return null;
	}
	return parameters.has("client_id") && parameters.has("sig") ? parameters.toString() : null;
}

const PASSWORD_RESET_OAUTH_QUERY_STORAGE_KEY = "yepnope.password-reset-oauth-query";

function rememberPasswordResetOAuthQuery(oauthQuery: string | null): void {
	if (oauthQuery === null) {
		window.sessionStorage.removeItem(PASSWORD_RESET_OAUTH_QUERY_STORAGE_KEY);
		return;
	}
	window.sessionStorage.setItem(PASSWORD_RESET_OAUTH_QUERY_STORAGE_KEY, oauthQuery);
}

function passwordResetOAuthQuery(): string | null {
	const oauthQuery = window.sessionStorage.getItem(PASSWORD_RESET_OAUTH_QUERY_STORAGE_KEY);
	if (oauthQuery === null) {
		return null;
	}
	const parameters = new URLSearchParams(oauthQuery);
	if (!parameters.has("client_id") || !parameters.has("sig") || parameters.has("token") || parameters.has("error")) {
		window.sessionStorage.removeItem(PASSWORD_RESET_OAUTH_QUERY_STORAGE_KEY);
		return null;
	}
	return oauthQuery;
}

function oauthCallbackPath(oauthQuery: string): string {
	return `/sign-in?${oauthQuery}`;
}

function followOAuthRedirect(url: string): void {
	const target = new URL(url, window.location.origin);
	if (target.origin === window.location.origin && viewFromPath(target.pathname) === "oauth-consent") {
		window.history.replaceState({}, "", `${target.pathname}${target.search}`);
		window.dispatchEvent(new PopStateEvent("popstate"));
		return;
	}
	window.location.assign(target.href);
}

const CODEX_ADD_COMMAND = "codex mcp add yepnope --url https://yepnope.app/mcp";
const CODEX_LOGIN_COMMAND = "codex mcp login yepnope";

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

function SignedOutLanding({onNavigate}: AccountRouteProps): ReactElement {
	return (
		<AccountPanel title="YepNope">
			<p>Sign in to answer questions from your coding agents, or create an account to get started.</p>
			<div className="signed-out-actions">
				<button
					type="button"
					onClick={() => {
						onNavigate("sign-in");
					}}
				>
					Sign in
				</button>
				<button
					type="button"
					className="secondary"
					onClick={() => {
						onNavigate("register");
					}}
				>
					Create account
				</button>
			</div>
		</AccountPanel>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

interface AuthenticationCompletionProps {
	onAuthenticated: (user: AuthenticationUser) => void;
	onOAuthAuthenticated: (user: AuthenticationUser, redirectUrl: string) => void;
}

interface SignInProps extends AccountRouteProps, AuthenticationCompletionProps {}

function SignIn({onAuthenticated, onNavigate, onOAuthAuthenticated}: SignInProps): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			if (oauthQuery === null) {
				onAuthenticated(await signIn(email, password));
			} else {
				const redirectUrl = await signInForOAuth(email, password, oauthQuery);
				const user = await fetchSession();
				if (user === null || !user.emailVerified) {
					throw new Error("Verify your YepNope email before authorizing this MCP client.");
				}
				onOAuthAuthenticated(user, redirectUrl);
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<AccountPanel title="Sign in">
			<p>
				{oauthQuery === null
					? "Sign in to recover your questions and settings on this browser."
					: "Sign in with your verified YepNope account to continue authorizing this MCP client."}
			</p>
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
					Back to YepNope
				</button>
			</div>
		</AccountPanel>
	);
}

interface RegisterProps extends AccountRouteProps {
	onRegistered: (email: string, delivery: VerificationDelivery) => void;
}

type VerificationDelivery = "accepted" | "failed" | "idle";

function Register({onNavigate, onRegistered}: RegisterProps): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const callbackURL = oauthQuery === null ? "/verify-email" : oauthCallbackPath(oauthQuery);
			if (oauthQuery === null) {
				await registerAccount(email, password);
			} else {
				await registerAccount(email, password, callbackURL);
			}
			try {
				if (oauthQuery === null) {
					await sendVerificationEmail(email);
				} else {
					await sendVerificationEmail(email, callbackURL);
				}
				onRegistered(email, "accepted");
			} catch {
				onRegistered(email, "failed");
			}
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
					Back to YepNope
				</button>
			</div>
		</AccountPanel>
	);
}

interface VerifyEmailProps extends AccountRouteProps {
	initialDelivery: VerificationDelivery;
	initialEmail: string;
}

function VerifyEmail({initialDelivery, initialEmail, onNavigate}: VerifyEmailProps): ReactElement {
	const parameters = new URLSearchParams(window.location.search);
	const oauthQuery = oauthQueryFromLocation();
	const verificationError = parameters.get("error");
	const [email, setEmail] = useState(initialEmail);
	const [delivery, setDelivery] = useState(initialDelivery);
	const [submitting, setSubmitting] = useState(false);
	const [resendCompleted, setResendCompleted] = useState(false);
	const hasRegistrationEmail = initialEmail !== "";

	async function resend(): Promise<void> {
		setSubmitting(true);
		setDelivery("idle");
		setResendCompleted(false);
		try {
			if (oauthQuery === null) {
				await sendVerificationEmail(email);
			} else {
				await sendVerificationEmail(email, oauthCallbackPath(oauthQuery));
			}
			setDelivery("accepted");
			setResendCompleted(true);
		} catch {
			setDelivery("failed");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<AccountPanel title="Verify your email">
			<p>
				{hasRegistrationEmail
					? "If verification is available, use the emailed link to finish creating your account."
					: "Enter your email to request another verification link."}
			</p>
			{delivery === "failed" && (
				<p className="form-error" role="alert">
					We couldn&apos;t submit that request. Try again.
				</p>
			)}
			{verificationError !== null && (
				<p className="form-error" role="alert">
					That verification link is invalid or expired.
				</p>
			)}
			{resendCompleted && (
				<p className="form-success" role="status">
					If verification is available, a new link will arrive by email.
				</p>
			)}
			{hasRegistrationEmail ? (
				<button type="button" disabled={submitting} aria-busy={submitting} onClick={() => void resend()}>
					{submitting ? "Sending…" : "Resend verification email"}
				</button>
			) : (
				<form
					className="account-form"
					onSubmit={(event) => {
						event.preventDefault();
						void resend();
					}}
				>
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
					<button type="submit" disabled={submitting} aria-busy={submitting}>
						{submitting ? "Sending…" : "Resend verification email"}
					</button>
				</form>
			)}
			<div className="account-links">
				<button
					type="button"
					onClick={() => {
						onNavigate("sign-in");
					}}
				>
					Back to sign in
				</button>
				<button
					type="button"
					onClick={() => {
						onNavigate("deck");
					}}
				>
					Back to YepNope
				</button>
			</div>
		</AccountPanel>
	);
}

function ForgotPassword({onNavigate}: AccountRouteProps): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const [email, setEmail] = useState("");
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setError(null);
		try {
			await requestPasswordReset(email);
			rememberPasswordResetOAuthQuery(oauthQuery);
			setSent(true);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<AccountPanel title="Reset your password">
			<p>Enter your email to request account recovery instructions.</p>
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
						If recovery is available for that address, check its inbox for next steps.
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
				<button
					type="button"
					onClick={() => {
						onNavigate("deck");
					}}
				>
					Back to YepNope
				</button>
			</div>
		</AccountPanel>
	);
}

enum PasswordResetPhase {
	Ready,
	Resetting,
	SigningIn,
	SignInFailed,
	ResumingAuthorization,
	AuthorizationResumeFailed,
}

interface ResetPasswordProps extends AccountRouteProps, AuthenticationCompletionProps {}

function ResetPassword({onAuthenticated, onNavigate, onOAuthAuthenticated}: ResetPasswordProps): ReactElement {
	const [{invalid, token}] = useState(() => {
		const parameters = new URLSearchParams(window.location.search);
		const initialToken = parameters.get("token");
		return {invalid: parameters.get("error") !== null || initialToken === null, token: initialToken};
	});
	const [oauthQuery] = useState(passwordResetOAuthQuery);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [authenticatedUser, setAuthenticatedUser] = useState<AuthenticationUser | null>(null);
	const [phase, setPhase] = useState(PasswordResetPhase.Ready);
	const [error, setError] = useState<string | null>(null);

	async function resumeAuthorization(user: AuthenticationUser, oauthQueryToResume: string): Promise<void> {
		setPhase(PasswordResetPhase.ResumingAuthorization);
		setError(null);
		try {
			const redirectUrl = await resumeOAuthAuthorization(oauthQueryToResume);
			rememberPasswordResetOAuthQuery(null);
			onOAuthAuthenticated(user, redirectUrl);
		} catch (caught) {
			setError(errorMessage(caught));
			setPhase(PasswordResetPhase.AuthorizationResumeFailed);
		}
	}

	async function authenticateAfterReset(): Promise<void> {
		setPhase(PasswordResetPhase.SigningIn);
		setError(null);
		let user: AuthenticationUser;
		try {
			user = await signIn(email, password);
		} catch (caught) {
			setError(errorMessage(caught));
			setPhase(PasswordResetPhase.SignInFailed);
			return;
		}
		setAuthenticatedUser(user);
		if (oauthQuery === null) {
			rememberPasswordResetOAuthQuery(null);
			onAuthenticated(user);
			return;
		}
		await resumeAuthorization(user, oauthQuery);
	}

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		if (token === null || phase !== PasswordResetPhase.Ready) {
			return;
		}
		setPhase(PasswordResetPhase.Resetting);
		setError(null);
		try {
			await consumePasswordResetToken(token, password);
		} catch (caught) {
			setError(errorMessage(caught));
			setPhase(PasswordResetPhase.Ready);
			return;
		}
		window.history.replaceState({}, "", "/reset-password");
		await authenticateAfterReset();
	}

	const resetSucceeded =
		phase === PasswordResetPhase.SigningIn ||
		phase === PasswordResetPhase.SignInFailed ||
		phase === PasswordResetPhase.ResumingAuthorization ||
		phase === PasswordResetPhase.AuthorizationResumeFailed;

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
			) : resetSucceeded ? (
				<>
					<p className="form-success" role="status">
						{phase === PasswordResetPhase.SigningIn
							? "Your password has been changed. Signing you in…"
							: phase === PasswordResetPhase.ResumingAuthorization
								? "Signed in. Continuing to authorization…"
								: phase === PasswordResetPhase.AuthorizationResumeFailed
									? "Your password has been changed and you are signed in."
									: "Your password has been changed."}
					</p>
					{error !== null && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					{phase === PasswordResetPhase.SignInFailed && (
						<form
							className="account-form"
							onSubmit={(event) => {
								event.preventDefault();
								void authenticateAfterReset();
							}}
						>
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
							<button type="submit">Try signing in again</button>
						</form>
					)}
					{phase === PasswordResetPhase.AuthorizationResumeFailed &&
						authenticatedUser !== null &&
						oauthQuery !== null && (
							<button
								type="button"
								onClick={() => void resumeAuthorization(authenticatedUser, oauthQuery)}
							>
								Continue authorization
							</button>
						)}
				</>
			) : (
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
					<button type="submit" disabled={phase === PasswordResetPhase.Resetting}>
						{phase === PasswordResetPhase.Resetting ? "Saving new password…" : "Save new password"}
					</button>
				</form>
			)}
			<div className="account-links">
				<button
					type="button"
					onClick={() => {
						onNavigate("deck");
					}}
				>
					Back to YepNope
				</button>
			</div>
		</AccountPanel>
	);
}

const OAUTH_CAPABILITIES = {
	openid: {
		description: "Confirm which verified YepNope account is authorizing the connection.",
		label: "Use your YepNope identity",
	},
	offline_access: {
		description: "Refresh this connection without asking you to sign in each time.",
		label: "Stay connected",
	},
	"yepnope:questions": {
		description: "Send questions to YepNope and wait for your Yep, Nope, or Skip answer.",
		label: "Ask questions",
	},
	"yepnope:afk": {
		description: "Read and change whether YepNope routes questions while you are away.",
		label: "Manage AFK routing",
	},
} as const;

function isOAuthCapability(scope: string): scope is keyof typeof OAUTH_CAPABILITIES {
	return Object.hasOwn(OAUTH_CAPABILITIES, scope);
}

function grantedScopeSummary(scopes: string[]): string {
	return scopes
		.map((scope) => (isOAuthCapability(scope) ? `${OAUTH_CAPABILITIES[scope].label} (${scope})` : scope))
		.join(", ");
}

function OAuthConsent(): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const parameters = new URLSearchParams(oauthQuery ?? "");
	const clientId = parameters.get("client_id");
	const requestedScopes = (parameters.get("scope") ?? "").split(" ").filter((scope) => scope !== "");
	const recognizedScopes = requestedScopes.filter(isOAuthCapability);
	const requestedResources = parameters.getAll("resource");
	const expectedResource = new URL("/mcp", window.location.origin).href;
	const requestIsValid =
		oauthQuery !== null &&
		clientId !== null &&
		requestedScopes.length > 0 &&
		requestedScopes.length === new Set(requestedScopes).size &&
		recognizedScopes.length === requestedScopes.length &&
		requestedResources.length === 1 &&
		requestedResources[0] === expectedResource;
	const [client, setClient] = useState<OAuthClientSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		if (!requestIsValid) {
			setError("This authorization request is invalid or has expired.");
			return undefined;
		}
		fetchOAuthClient(clientId).then(
			(loadedClient) => {
				if (!cancelled) {
					setClient(loadedClient);
				}
			},
			() => {
				if (!cancelled) {
					setError("This MCP client could not be verified. Start the connection again from the client.");
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [clientId, requestIsValid]);

	async function decide(accept: boolean): Promise<void> {
		if (oauthQuery === null || !requestIsValid) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			followOAuthRedirect(await submitOAuthConsent(oauthQuery, accept));
		} catch (caught) {
			setError(errorMessage(caught));
			setSubmitting(false);
		}
	}

	return (
		<AccountPanel title="Authorize MCP client">
			{client === null ? (
				<p>{error === null ? "Checking the requesting client…" : "YepNope cannot continue this request."}</p>
			) : (
				<p>
					<strong>{client.name}</strong> wants to connect to your YepNope account.
				</p>
			)}
			{requestIsValid && (
				<ul className="oauth-capabilities">
					{recognizedScopes.map((scope) => {
						const capability = OAUTH_CAPABILITIES[scope];
						return (
							<li key={scope}>
								<strong>{capability.label}</strong>
								<span>{capability.description}</span>
							</li>
						);
					})}
				</ul>
			)}
			{error !== null && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			{client !== null && requestIsValid && (
				<div className="oauth-actions">
					<button type="button" disabled={submitting} onClick={() => void decide(true)}>
						{submitting ? "Responding…" : "Allow"}
					</button>
					<button
						type="button"
						className="secondary"
						disabled={submitting}
						onClick={() => void decide(false)}
					>
						Cancel
					</button>
				</div>
			)}
		</AccountPanel>
	);
}

interface ManagedDeviceRowProps {
	label: string;
	metadata: string;
	onRename?: (label: string) => Promise<void>;
	onRevoke?: () => Promise<void>;
}

function ManagedDeviceRow({label, metadata, onRename, onRevoke}: ManagedDeviceRowProps): ReactElement {
	const [editing, setEditing] = useState(false);
	const [nextLabel, setNextLabel] = useState(label);
	const [busy, setBusy] = useState(false);

	async function save(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setBusy(true);
		if (onRename === undefined) {
			throw new Error("this connected client cannot be renamed");
		}
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
						<small>{metadata}</small>
					</div>
					{(onRename !== undefined || onRevoke !== undefined) && (
						<div className="device-actions">
							{onRename !== undefined && (
								<button
									type="button"
									className="secondary"
									onClick={() => {
										setEditing(true);
									}}
								>
									Rename
								</button>
							)}
							{onRevoke !== undefined && (
								<button
									type="button"
									className="secondary"
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
							)}
						</div>
					)}
				</>
			)}
		</li>
	);
}

interface InstallCommandProps {
	command: string;
	label: string;
}

function InstallCommand({command, label}: InstallCommandProps): ReactElement {
	const [copyState, setCopyState] = useState<"copied" | "error" | "idle">("idle");
	return (
		<div className="install-command">
			<div>
				<strong>{label}</strong>
				<code>{command}</code>
			</div>
			<button
				type="button"
				className="secondary"
				onClick={() => {
					void navigator.clipboard.writeText(command).then(
						() => {
							setCopyState("copied");
						},
						() => {
							setCopyState("error");
						},
					);
				}}
			>
				{copyState === "copied" ? "Copied" : "Copy"}
			</button>
			{copyState === "error" && <small role="alert">Copy is blocked. Select the command manually.</small>}
		</div>
	);
}

function Settings({
	session,
	connectedMcpClientCount,
	onBack,
	onSignIn,
	onRegister,
	onSignedOut,
}: SettingsProps): ReactElement {
	const requiresIosInstall = isIos() && !isStandalone();
	const [accountError, setAccountError] = useState<string | null>(null);
	const [accountDevices, setAccountDevices] = useState<AccountDevices | null>(null);
	const [devicesError, setDevicesError] = useState<string | null>(null);
	const [devicesLoading, setDevicesLoading] = useState(false);
	const [pushState, setPushState] = useState<PushSetupResult | "idle" | "error">(
		"Notification" in window && Notification.permission === "granted" ? "subscribed" : "idle",
	);
	const onSignedOutRef = useRef(onSignedOut);
	onSignedOutRef.current = onSignedOut;

	const reloadDevices = useCallback(async (): Promise<void> => {
		if (session === null) {
			setAccountDevices(null);
			return;
		}
		setDevicesLoading(true);
		try {
			setAccountDevices(await fetchAccountDevices());
			setDevicesError(null);
		} catch (caught) {
			if (caught instanceof ApiResponseError && (caught.status === 401 || caught.status === 403)) {
				setAccountDevices(null);
				onSignedOutRef.current();
				return;
			}
			setDevicesError(errorMessage(caught));
		} finally {
			setDevicesLoading(false);
		}
	}, [session]);

	useEffect(() => {
		void reloadDevices();
	}, [connectedMcpClientCount, reloadDevices]);

	async function runDeviceAction(action: () => Promise<void>): Promise<void> {
		setDevicesError(null);
		try {
			await action();
			await reloadDevices();
		} catch (caught) {
			if (caught instanceof ApiResponseError && (caught.status === 401 || caught.status === 403)) {
				onSignedOutRef.current();
				return;
			}
			setDevicesError(errorMessage(caught));
		}
	}

	return (
		<div className="settings">
			<div className="hint account-summary">
				<h3>Account</h3>
				{session === null ? (
					<>
						<p>Sign in to receive live questions and use the same account on every browser.</p>
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
			<div className="hint connected-clients">
				<h3>Connected MCP clients</h3>
				<p>OAuth-authorized clients can ask questions and manage only the capabilities you approve.</p>
				<div className="install-steps">
					<InstallCommand command={CODEX_ADD_COMMAND} label="1. Add YepNope to Codex" />
					<InstallCommand command={CODEX_LOGIN_COMMAND} label="2. Sign in when Codex requests it" />
				</div>
				<p>
					Codex opens YepNope in your browser for account sign-in and consent. If authorization does not open
					automatically, run the login command. No token or browser cookie belongs in Codex configuration.
				</p>
				<p>
					<a href="https://developers.openai.com/codex/mcp/" target="_blank" rel="noreferrer">
						Open the official Codex MCP instructions
					</a>
				</p>
				{session === null ? (
					<>
						<p>Sign in before authorizing a client.</p>
						<button type="button" onClick={onSignIn}>
							Sign in
						</button>
					</>
				) : accountDevices === null ? (
					<p>{devicesLoading ? "Loading connected clients…" : "Connected clients are unavailable."}</p>
				) : accountDevices.connectedMcpClients.length === 0 ? (
					<p>No connected MCP clients.</p>
				) : (
					<ul className="device-list">
						{accountDevices.connectedMcpClients.map((client) => (
							<ManagedDeviceRow
								key={client.id}
								label={client.displayName}
								metadata={`Authorized ${new Date(client.authorizedAt).toLocaleString()} · ${client.lastUsedAt === null ? "Not used yet" : `Last used ${new Date(client.lastUsedAt).toLocaleString()}`} · Granted scopes: ${grantedScopeSummary(client.grantedScopes)} · ${client.status}`}
								onRevoke={async () =>
									runDeviceAction(async () => {
										await revokeConnectedMcpClient(client.id);
									})
								}
							/>
						))}
					</ul>
				)}
				{session !== null && (
					<button
						type="button"
						className="secondary refresh-devices"
						disabled={devicesLoading}
						onClick={() => void reloadDevices()}
					>
						{devicesLoading ? "Refreshing…" : "Refresh connected clients"}
					</button>
				)}
				{devicesError !== null && (
					<p className="form-error" role="alert">
						{devicesError}
					</p>
				)}
			</div>
			<div className="hint">
				<h3>Signed-in browsers</h3>
				<p>
					Another phone or browser signs into this same YepNope account directly; no setup codes are needed.
					Browser sessions do not authorize MCP clients or receive notifications by themselves.
				</p>
				{session === null ? (
					<p>Sign in to see active browser sessions.</p>
				) : accountDevices === null ? (
					<p>Loading browser sessions…</p>
				) : accountDevices.browserSessions.length === 0 ? (
					<p>No active browser sessions.</p>
				) : (
					<ul className="device-list">
						{accountDevices.browserSessions.map((browserSession) => (
							<ManagedDeviceRow
								key={browserSession.id}
								label={`${browserSession.displayName}${browserSession.current ? " · This browser" : ""}`}
								metadata={`Signed in ${new Date(browserSession.createdAt).toLocaleString()} · Last active ${new Date(browserSession.lastActiveAt).toLocaleString()} · Expires ${new Date(browserSession.expiresAt).toLocaleString()}`}
							/>
						))}
					</ul>
				)}
			</div>
			<IosInstallHint required={requiresIosInstall} />
			<div className="hint">
				<h3>Browser notifications</h3>
				<p>
					Enabling notifications registers only this browser's push subscription. It does not sign in another
					browser or authorize an MCP client.
				</p>
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
					<p>Enabled on this browser. One notification is sent per batch of questions.</p>
				) : (
					<>
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
				{session !== null && accountDevices !== null && accountDevices.pushDevices.length === 0 ? (
					<p>No browsers receive notifications.</p>
				) : (
					<ul className="device-list">
						{accountDevices?.pushDevices.map((device) => (
							<ManagedDeviceRow
								key={device.id}
								label={device.label}
								metadata={`Notifications enabled ${new Date(device.createdAt).toLocaleString()}`}
								onRename={async (label) =>
									runDeviceAction(async () => renamePushDevice(device.id, label))
								}
								onRevoke={async () => runDeviceAction(async () => revokePushDevice(device.id))}
							/>
						))}
					</ul>
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
	const [connectedMcpClientCount, setConnectedMcpClientCount] = useState<number | null>(null);
	const [view, setView] = useState<AppView>(() => viewFromPath(window.location.pathname));
	const [registrationEmail, setRegistrationEmail] = useState("");
	const [verificationDelivery, setVerificationDelivery] = useState<VerificationDelivery>("idle");
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
			"oauth-consent": "Authorize MCP client · YepNope",
		};
		document.title = titles[view];
	}, [view]);

	function navigate(nextView: AppView): void {
		const oauthQuery = oauthQueryFromLocation();
		const preserveOAuthQuery =
			oauthQuery !== null &&
			(nextView === "sign-in" ||
				nextView === "register" ||
				nextView === "verify-email" ||
				nextView === "forgot-password");
		const target = `${pathForView(nextView)}${preserveOAuthQuery ? `?${oauthQuery}` : ""}`;
		if (`${window.location.pathname}${window.location.search}` !== target) {
			window.history.pushState({}, "", target);
		}
		setView(nextView);
	}

	const showSignedOutLanding = useCallback(() => {
		currentDeckStream.current?.close();
		currentDeckStream.current = null;
		setCurrentQuestions([]);
		setAfkState(null);
		setConnectedMcpClientCount(null);
		updateBadge(0);
		rememberPasswordResetOAuthQuery(null);
		setSession(null);
		setSessionReady(true);
		if (`${window.location.pathname}${window.location.search}` !== "/") {
			window.history.replaceState({}, "", "/");
		}
		setView("deck");
	}, []);

	useEffect(() => {
		let cancelled = false;
		fetchSession().then(
			(user) => {
				if (!cancelled) {
					const oauthQuery = oauthQueryFromLocation();
					if (user === null && oauthQuery !== null && window.location.pathname === "/oauth/consent") {
						window.history.replaceState({}, "", `/sign-in?${oauthQuery}`);
						setView("sign-in");
					}
					if (
						user !== null &&
						oauthQuery !== null &&
						(window.location.pathname === "/sign-in" || window.location.pathname === "/verify-email")
					) {
						setSession(user);
						setSessionReady(true);
						resumeOAuthAuthorization(oauthQuery).then(followOAuthRedirect, () => {
							if (!cancelled) {
								setSession(user);
								setSessionReady(true);
							}
						});
						return;
					}
					if (user === null && window.location.pathname === "/settings") {
						showSignedOutLanding();
						return;
					}
					setSession(user);
					if (user !== null && window.location.pathname === "/verify-email") {
						window.history.replaceState({}, "", "/");
						setView("deck");
					}
					setSessionReady(true);
				}
			},
			() => {
				if (!cancelled) {
					showSignedOutLanding();
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [showSignedOutLanding]);

	const refreshAfk = useCallback(() => {
		if (session === null) {
			return;
		}
		fetchAfk().then(setAfkState, (caught: unknown) => {
			if (caught instanceof ApiResponseError && (caught.status === 401 || caught.status === 403)) {
				showSignedOutLanding();
				return;
			}
			setAfkState(null);
		});
	}, [session, showSignedOutLanding]);

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
				currentDeckStream.current?.refresh();
			},
			() => {
				// Keep the credential so the signed-in user can retry the explicit claim.
			},
		);
	}, [refreshAfk, session]);

	useEffect(() => {
		if (session === null) {
			setCurrentQuestions([]);
			setAfkState(null);
			setConnectedMcpClientCount(null);
			updateBadge(0);
			return undefined;
		}
		refreshAfk();
		let active = true;
		const stream = openCurrentDeckStream(
			(state) => {
				if (!active) {
					return;
				}
				setAfkState(state.afk);
				setConnectedMcpClientCount(state.connectedMcpClientCount);
				setCurrentQuestions(state.currentDeck);
				updateBadge(state.currentDeck.length);
			},
			{
				onSignedOut: () => {
					if (active) {
						showSignedOutLanding();
					}
				},
			},
		);
		currentDeckStream.current = stream;
		function onVisible(): void {
			if (document.visibilityState === "visible") {
				stream.refresh();
				refreshAfk();
			}
		}
		function onServiceWorkerMessage(event: MessageEvent<unknown>): void {
			if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) {
				return;
			}
			if (event.data.type !== "account-state-changed") {
				return;
			}
			stream.refresh();
			refreshAfk();
		}
		document.addEventListener("visibilitychange", onVisible);
		const workerContainer = "serviceWorker" in navigator ? navigator.serviceWorker : null;
		workerContainer?.addEventListener("message", onServiceWorkerMessage);
		return () => {
			active = false;
			if (currentDeckStream.current === stream) {
				stream.close();
				currentDeckStream.current = null;
			}
			document.removeEventListener("visibilitychange", onVisible);
			workerContainer?.removeEventListener("message", onServiceWorkerMessage);
		};
	}, [refreshAfk, session, showSignedOutLanding, view]);

	function onAnswer(questionId: string, disposition: Disposition): void {
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
				if (session === null) {
					return <SignedOutLanding onNavigate={navigate} />;
				}
				return (
					<Settings
						session={session}
						connectedMcpClientCount={connectedMcpClientCount}
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
							showSignedOutLanding();
						}}
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
						onOAuthAuthenticated={(user, redirectUrl) => {
							setSession(user);
							setSessionReady(true);
							followOAuthRedirect(redirectUrl);
						}}
					/>
				);
			case "register":
				return (
					<Register
						onNavigate={navigate}
						onRegistered={(email, delivery) => {
							setRegistrationEmail(email);
							setVerificationDelivery(delivery);
							navigate("verify-email");
						}}
					/>
				);
			case "verify-email":
				return (
					<VerifyEmail
						initialDelivery={verificationDelivery}
						initialEmail={registrationEmail}
						onNavigate={navigate}
					/>
				);
			case "forgot-password":
				return <ForgotPassword onNavigate={navigate} />;
			case "reset-password":
				return (
					<ResetPassword
						onNavigate={navigate}
						onAuthenticated={(user) => {
							setSession(user);
							setSessionReady(true);
							navigate("settings");
						}}
						onOAuthAuthenticated={(user, redirectUrl) => {
							setSession(user);
							setSessionReady(true);
							followOAuthRedirect(redirectUrl);
						}}
					/>
				);
			case "oauth-consent":
				if (!sessionReady) {
					return <div className="loading">Checking your session…</div>;
				}
				if (session === null) {
					return <div className="loading">Sign in is required to continue.</div>;
				}
				return <OAuthConsent />;
			case "deck":
				if (!sessionReady) {
					return <div className="loading">Checking your session…</div>;
				}
				if (session === null) {
					return <SignedOutLanding onNavigate={navigate} />;
				}
				return <Deck questions={currentQuestions} onAnswer={onAnswer} />;
		}
		return unreachableView(view);
	}
	const showApplicationHeader = sessionReady && session !== null && (view === "deck" || view === "settings");

	return (
		<div className={view === "settings" ? "app app-settings" : "app"}>
			{showApplicationHeader && (
				<div className="app-header">
					<span className="meta">
						{view === "deck" && (
							<AfkToggle
								afk={afk}
								connectedMcpClientCount={connectedMcpClientCount}
								onOpenSettings={() => {
									navigate("settings");
								}}
								onToggle={onToggleAfk}
							/>
						)}
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
			)}
			{currentView()}
		</div>
	);
}
