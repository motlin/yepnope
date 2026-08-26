import {useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent} from "react";
import {
	consumePasswordResetToken,
	decideDeviceAuthorization,
	deletePasskey,
	fetchAccountDevices,
	fetchAfk,
	fetchDeviceAuthorization,
	fetchAuthenticationMethods,
	fetchLinkedAccounts,
	fetchOAuthClient,
	fetchPasskeys,
	fetchSession,
	linkSocialAccount,
	openCurrentDeckStream,
	registerAccount,
	registerPasskey,
	requestPasswordReset,
	resumeOAuthAuthorization,
	renamePushDevice,
	revokeConnectedMcpClient,
	revokePushDevice,
	sendMagicLink,
	sendVerificationEmail,
	signIn,
	signInForOAuth,
	signInWithPasskey,
	signOut,
	startSocialSignIn,
	submitAnswer,
	submitOAuthConsent,
	unlinkAccount,
	updateAfk,
	ApiResponseError,
	SOCIAL_PROVIDER_LABELS,
	type AuthenticationMethods,
	type AuthenticationUser,
	type AccountDevices,
	type CurrentDeckStream,
	type DeviceAuthorizationDecision,
	type DeviceAuthorizationLookup,
	type DeviceAuthorizationResult,
	type LinkedAccount,
	type OAuthClientSummary,
	type PendingDeviceAuthorization,
	type RegisteredPasskey,
	type SocialProvider,
} from "./api";
import {Deck, type DeckQuestion, type Disposition} from "./deck";
import {HumanVerificationField} from "./human-verification";
import {enablePush, isIos, isStandalone, updateBadge, type PushSetupResult} from "./push";
import {THEME_CHOICES, useTheme, type ResolvedTheme, type Theme} from "./theme";
import {humanVerificationBlocksSubmit, useHumanVerification, type HumanVerification} from "./turnstile";

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
	onConnectClient: () => void;
	onToggle: () => void;
}

function AfkToggle({afk, connectedMcpClientCount, onConnectClient, onToggle}: AfkToggleProps): ReactElement {
	if (connectedMcpClientCount === null) {
		return (
			<button type="button" className="account-status" disabled>
				Checking account…
			</button>
		);
	}
	if (connectedMcpClientCount === 0) {
		return (
			<button type="button" className="account-status" onClick={onConnectClient}>
				Connect Claude Code or Codex
			</button>
		);
	}
	const checking = afk === null;
	const enabled = afk === true;
	const afkClassName = checking ? "afk-toggle afk-checking" : enabled ? "afk-toggle afk-on" : "afk-toggle afk-off";
	return (
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
	);
}

interface SettingsProps {
	session: AuthenticationUser | null;
	connectedMcpClientCount: number | null;
	/** Set when the reader arrived here to connect a client, so the instructions are what they land on. */
	focusConnectedClients: boolean;
	theme: Theme;
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
	| "oauth-consent"
	| "device";

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
		case "/device":
			return "device";
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
		case "device":
			return "/device";
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

function deviceUserCodeFromLocation(): string {
	return new URLSearchParams(window.location.search).get("user_code") ?? "";
}

// 📟 The user code is the only thing tying this browser to the terminal that is waiting on it, so a
// sign-in detour has to carry it along and land back on /device rather than the deck.
const DEVICE_HANDOFF_VIEWS: readonly AppView[] = ["device", "forgot-password", "register", "sign-in", "verify-email"];

function deviceHandoffQuery(nextView: AppView): string {
	const userCode = deviceUserCodeFromLocation();
	return userCode === "" || !DEVICE_HANDOFF_VIEWS.includes(nextView)
		? ""
		: `?user_code=${encodeURIComponent(userCode)}`;
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

/**
 * Where an authentication step that leaves the page — a provider, an emailed link, a verification
 * message — sends the visitor back to. An authorization waiting on them outranks `fallback`, which
 * is where the same step lands when nobody is waiting.
 */
function authenticationCallbackPath(oauthQuery: string | null, fallback: string): string {
	return oauthQuery === null ? fallback : `/sign-in?${oauthQuery}`;
}

/** Returns true when the browser leaves YepNope for the requesting client. */
function followOAuthRedirect(url: string): boolean {
	const target = new URL(url, window.location.origin);
	if (target.origin === window.location.origin && viewFromPath(target.pathname) === "oauth-consent") {
		window.history.replaceState({}, "", `${target.pathname}${target.search}`);
		window.dispatchEvent(new PopStateEvent("popstate"));
		return false;
	}
	window.location.assign(target.href);
	return true;
}

interface SetupStep {
	readonly label: string;
	readonly command: string;
}

interface McpClientSetup {
	readonly name: string;
	/** The plugin install, which registers the MCP server and both skills in one step. */
	readonly pluginSteps: readonly SetupStep[];
	readonly authorization: string;
	/** The same connection registered by hand, for anyone who does not want the plugin. */
	readonly manualSteps: readonly SetupStep[];
	readonly docsLabel: string;
	readonly docsUrl: string;
}

// 🧭 Every supported client is spelled out, because the browser cannot tell which one is asking and
// guessing wrong strands the reader on instructions for somebody else's CLI.
const MCP_CLIENT_SETUPS: readonly McpClientSetup[] = [
	{
		name: "Claude Code",
		pluginSteps: [
			{label: "1. Add the YepNope marketplace", command: "claude plugin marketplace add motlin/yepnope"},
			{label: "2. Install the plugin", command: "claude plugin install yepnope@yepnope"},
		],
		authorization:
			"Start a new Claude Code session. It opens YepNope in your browser for account sign-in and consent. " +
			"If authorization does not open automatically, run /mcp, select yepnope, and authorize there. No token " +
			"or browser cookie belongs in Claude Code configuration.",
		manualSteps: [
			{
				label: "Without the plugin: register the server",
				command: "claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp",
			},
			{label: "Without the plugin: authorize it", command: "/mcp"},
		],
		docsLabel: "Open the official Claude Code MCP instructions",
		docsUrl: "https://docs.claude.com/en/docs/claude-code/mcp",
	},
	{
		name: "Codex",
		pluginSteps: [
			{label: "1. Add the YepNope marketplace", command: "codex plugin marketplace add motlin/yepnope"},
			{label: "2. Install the plugin", command: "codex plugin add yepnope@yepnope"},
		],
		authorization:
			"Start a new Codex session. It opens YepNope in your browser for account sign-in and consent. If " +
			"authorization does not open automatically, run the login command. No token or browser cookie belongs " +
			"in Codex configuration.",
		manualSteps: [
			{
				label: "Without the plugin: register the server",
				command: "codex mcp add yepnope --url https://yepnope.app/mcp",
			},
			{label: "Without the plugin: authorize it", command: "codex mcp login yepnope"},
		],
		docsLabel: "Open the official Codex MCP instructions",
		docsUrl: "https://developers.openai.com/codex/mcp/",
	},
];

interface AccountRouteProps {
	onNavigate: (view: AppView) => void;
}

/** A signed-out page carrying a form, which needs the current palette for its Turnstile widget. */
interface AccountFormRouteProps extends AccountRouteProps {
	theme: ResolvedTheme;
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

/**
 * The §13.2 privacy position, stated where the decision is actually made.
 *
 * The signed-in settings page carries the same sentences, but a visitor weighing whether to hand
 * YepNope anything cannot reach settings yet, so every signed-out surface that asks them for
 * something repeats it. The closing sentence is Cloudflare's Turnstile disclosure, said here before
 * the widget appears rather than only beside it on the form.
 */
function SignedOutPrivacy(): ReactElement {
	return (
		<p className="signed-out-privacy">
			YepNope can read question bodies and answers. End-to-end encryption is not part of this MVP. Question bodies
			and answers are deleted seven days after each batch is created. Signing in and creating an account send this
			browser through a Cloudflare Turnstile check.
		</p>
	);
}

function SignedOutLanding({onNavigate}: AccountRouteProps): ReactElement {
	return (
		<AccountPanel title="YepNope">
			<p>Sign in to answer questions from your coding agents, or create an account to get started.</p>
			<SignedOutPrivacy />
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

// 🔑 Alternative sign-in methods. Discovery is an enhancement, never a gate: if the Worker cannot be
// reached the page still renders the email and password form it has always rendered.
const NO_ALTERNATIVE_METHODS: AuthenticationMethods = {
	emailPassword: true,
	magicLink: false,
	passkey: false,
	social: [],
	turnstileSiteKey: null,
};

const METHOD_DISCOVERY_FAILED_MESSAGE =
	"We could not reach YepNope to set this page up. Check your connection and reload.";

const MAGIC_LINK_SENT_MESSAGE =
	"If the request can be completed, check your inbox for a sign-in link. It expires in 15 minutes.";
const MAGIC_LINK_MISSING_EMAIL_MESSAGE = "Enter your email address first.";
// One message for every provider failure. Better Auth's own codes distinguish "no matching account"
// from "email does not match", and repeating that distinction would tell an anonymous visitor
// whether an account exists — the very thing the Worker's non-enumerating handler hides.
const PROVIDER_SIGN_IN_FAILED_MESSAGE =
	"Sign-in through that provider did not complete. Sign in another way, then connect it from Settings.";

function signInRedirectError(): string | null {
	return new URLSearchParams(window.location.search).has("error") ? PROVIDER_SIGN_IN_FAILED_MESSAGE : null;
}

// 🪫 An authorization that cannot be resumed is stranded: the browser is signed in, the client is
// still waiting, and nothing the visitor does in YepNope will finish it. The Worker refuses without
// naming a cause on purpose, so this says the one thing that is both true and actionable.
const OAUTH_RESUME_FAILED_MESSAGE =
	"We could not finish authorizing that MCP client. Start the connection again from the client.";

// Discovery now carries one answer the page cannot guess at: whether this deployment demands a
// human-verification check. So the three outcomes stay distinct instead of collapsing into one
// object, and a page that has not heard back yet knows it has not heard back yet.
type MethodDiscovery = {status: "pending"} | {status: "ready"; methods: AuthenticationMethods} | {status: "failed"};

function useAuthenticationMethods(): MethodDiscovery {
	const [discovery, setDiscovery] = useState<MethodDiscovery>({status: "pending"});
	useEffect(() => {
		let abandoned = false;
		void fetchAuthenticationMethods().then(
			(methods) => {
				if (!abandoned) {
					setDiscovery({methods, status: "ready"});
				}
			},
			() => {
				if (!abandoned) {
					setDiscovery({status: "failed"});
				}
			},
		);
		return () => {
			abandoned = true;
		};
	}, []);
	return discovery;
}

/** Alternative sign-in methods stay an enhancement: not knowing them still renders the page. */
function alternativeMethods(discovery: MethodDiscovery): AuthenticationMethods {
	return discovery.status === "ready" ? discovery.methods : NO_ALTERNATIVE_METHODS;
}

interface AccountForm {
	/** True while a submission could only be refused, so the control that would send it stays inert. */
	blocked: boolean;
	discoveryError: string | null;
	methods: AuthenticationMethods;
	verification: HumanVerification;
}

/**
 * Everything a signed-out form needs from discovery, with the widget bound to the one surface that
 * form protects.
 *
 * Human verification is the opposite of an enhancement. Until the deployment has said whether a
 * check is required, a submission could only be a refusal, so the form holds it back and says why.
 */
function useAccountForm(action: string, theme: ResolvedTheme): AccountForm {
	const discovery = useAuthenticationMethods();
	// Before discovery answers, the placeholder methods carry a null site key — the same value a
	// deployment that wants no widget sends. `blocked` is what keeps those two apart, holding the
	// form back until the answer has actually arrived.
	const methods = alternativeMethods(discovery);
	const verification = useHumanVerification(action, methods.turnstileSiteKey, theme);
	return {
		blocked: discovery.status !== "ready" || humanVerificationBlocksSubmit(verification),
		discoveryError: discovery.status === "failed" ? METHOD_DISCOVERY_FAILED_MESSAGE : null,
		methods,
		verification,
	};
}

function passkeysUsable(methods: AuthenticationMethods): boolean {
	return methods.passkey && "PublicKeyCredential" in window;
}

interface EmailedSignInLinkProps {
	/**
	 * Where the emailed link lands once it has signed the visitor in: the deck, or the signed
	 * authorization request that sent them here in the first place.
	 */
	callbackURL: string;
	/** Whatever the surrounding page's own email field holds; the link goes nowhere else. */
	email: string;
	disabled: boolean;
	onError: (message: string | null) => void;
	verificationToken: () => Promise<string | null>;
}

/**
 * The one way in that needs no password, no passkey, and no provider. It sits on the sign-in page as
 * an alternative and on the recovery page as the path for an account that never had a password to
 * reset, so both pages offer it in the same words and send it the same way.
 *
 * The link carries the same callback a provider button would, so an authorization waiting on this
 * visitor resumes when they follow it out of their inbox instead of stranding the client that
 * started it behind a deck that looks perfectly signed in.
 */
function EmailedSignInLink({
	callbackURL,
	disabled,
	email,
	onError,
	verificationToken,
}: EmailedSignInLinkProps): ReactElement {
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function send(): Promise<void> {
		if (email.trim() === "") {
			setStatus(null);
			onError(MAGIC_LINK_MISSING_EMAIL_MESSAGE);
			return;
		}
		setBusy(true);
		setStatus(null);
		onError(null);
		try {
			await sendMagicLink(email, await verificationToken(), callbackURL);
			setStatus(MAGIC_LINK_SENT_MESSAGE);
		} catch (caught) {
			onError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button type="button" className="secondary" disabled={busy || disabled} onClick={() => void send()}>
				Email me a sign-in link
			</button>
			{status !== null && (
				<p className="form-success" role="status">
					{status}
				</p>
			)}
		</>
	);
}

interface AlternativeSignInProps {
	callbackURL: string;
	email: string;
	methods: AuthenticationMethods;
	onAuthenticated: (user: AuthenticationUser) => void;
	onError: (message: string | null) => void;
	// 🤖 An emailed sign-in link is another way to ask this Worker to send mail, so it goes through
	// the same check as the password form beside it, sharing that page's single widget.
	verificationBlocked: boolean;
	verificationToken: () => Promise<string | null>;
}

function AlternativeSignIn({
	callbackURL,
	email,
	methods,
	onAuthenticated,
	onError,
	verificationBlocked,
	verificationToken,
}: AlternativeSignInProps): ReactElement | null {
	const [busy, setBusy] = useState(false);
	const passkeyAvailable = passkeysUsable(methods);

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		onError(null);
		try {
			await action();
		} catch (caught) {
			onError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	if (methods.social.length === 0 && !methods.magicLink && !passkeyAvailable) {
		return null;
	}
	return (
		<div className="sign-in-alternatives">
			<p className="sign-in-alternatives-divider">Or</p>
			{methods.social.map((provider) => (
				<button
					key={provider}
					type="button"
					className="secondary"
					disabled={busy}
					onClick={() =>
						void run(async () => {
							followOAuthRedirect(await startSocialSignIn(provider, callbackURL));
						})
					}
				>
					Continue with {SOCIAL_PROVIDER_LABELS[provider]}
				</button>
			))}
			{passkeyAvailable && (
				<button
					type="button"
					className="secondary"
					disabled={busy}
					onClick={() =>
						void run(async () => {
							onAuthenticated(await signInWithPasskey());
						})
					}
				>
					Sign in with a passkey
				</button>
			)}
			{methods.magicLink && (
				<EmailedSignInLink
					callbackURL={callbackURL}
					disabled={busy || verificationBlocked}
					email={email}
					onError={onError}
					verificationToken={verificationToken}
				/>
			)}
		</div>
	);
}

interface SignInProps extends AccountFormRouteProps, AuthenticationCompletionProps {}

function SignIn({onAuthenticated, onNavigate, onOAuthAuthenticated, theme}: SignInProps): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const {blocked, discoveryError, methods, verification} = useAccountForm("sign_in", theme);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(signInRedirectError);
	const [submitting, setSubmitting] = useState(false);
	const displayedError = error ?? discoveryError;

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const humanVerificationToken = await verification.consume();
			if (oauthQuery === null) {
				onAuthenticated(await signIn(email, password, humanVerificationToken));
			} else {
				// The authorization query rides through verification untouched, so a refused check
				// costs the visitor a retry rather than the MCP client's whole authorization.
				const redirectUrl = await signInForOAuth(email, password, oauthQuery, humanVerificationToken);
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
			<SignedOutPrivacy />
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
				<HumanVerificationField verification={verification} />
				{displayedError !== null && (
					<p className="form-error" role="alert">
						{displayedError}
					</p>
				)}
				<button type="submit" disabled={submitting || blocked}>
					{submitting ? "Signing in…" : "Sign in"}
				</button>
			</form>
			<AlternativeSignIn
				callbackURL={authenticationCallbackPath(oauthQuery, "/")}
				email={email}
				methods={methods}
				onAuthenticated={onAuthenticated}
				onError={setError}
				verificationBlocked={blocked}
				verificationToken={verification.consume}
			/>
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

interface RegisterProps extends AccountFormRouteProps {
	onRegistered: (email: string, delivery: VerificationDelivery) => void;
}

type VerificationDelivery = "accepted" | "failed" | "idle";

function Register({onNavigate, onRegistered, theme}: RegisterProps): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const {blocked, discoveryError, verification} = useAccountForm("register", theme);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const displayedError = error ?? discoveryError;

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const callbackURL = authenticationCallbackPath(oauthQuery, "/verify-email");
			await registerAccount(email, password, await verification.consume(), callbackURL);
			try {
				// 🎟️ Creating the account spent the first token, so the message that follows it
				// waits for the widget to earn a second one rather than replaying the first.
				await sendVerificationEmail(email, await verification.consume(), callbackURL);
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
			<SignedOutPrivacy />
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
				<HumanVerificationField verification={verification} />
				{displayedError !== null && (
					<p className="form-error" role="alert">
						{displayedError}
					</p>
				)}
				<button type="submit" disabled={submitting || blocked}>
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

interface VerifyEmailProps extends AccountFormRouteProps {
	initialDelivery: VerificationDelivery;
	initialEmail: string;
}

function VerifyEmail({initialDelivery, initialEmail, onNavigate, theme}: VerifyEmailProps): ReactElement {
	const parameters = new URLSearchParams(window.location.search);
	const oauthQuery = oauthQueryFromLocation();
	const verificationError = parameters.get("error");
	const {blocked, discoveryError, verification} = useAccountForm("verify_email", theme);
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
			const callbackURL = authenticationCallbackPath(oauthQuery, "/verify-email");
			await sendVerificationEmail(email, await verification.consume(), callbackURL);
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
					? "If verification is available for that address, the emailed link finishes creating your account. Delivery can take a few minutes, and the message can land in spam."
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
					Verification was requested. If a link is available for that address, it can take a few minutes to
					arrive, so check your spam folder too.
				</p>
			)}
			{discoveryError !== null && (
				<p className="form-error" role="alert">
					{discoveryError}
				</p>
			)}
			{hasRegistrationEmail ? (
				<>
					<HumanVerificationField verification={verification} />
					<button
						type="button"
						disabled={submitting || blocked}
						aria-busy={submitting}
						onClick={() => void resend()}
					>
						{submitting ? "Sending…" : "Resend verification email"}
					</button>
				</>
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
					<HumanVerificationField verification={verification} />
					<button type="submit" disabled={submitting || blocked} aria-busy={submitting}>
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

function ForgotPassword({onNavigate, theme}: AccountFormRouteProps): ReactElement {
	const oauthQuery = oauthQueryFromLocation();
	const {blocked, discoveryError, methods, verification} = useAccountForm("reset_password", theme);
	const [email, setEmail] = useState("");
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const displayedError = error ?? discoveryError;

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setError(null);
		try {
			await requestPasswordReset(email, await verification.consume());
			rememberPasswordResetOAuthQuery(oauthQuery);
			setSent(true);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<AccountPanel title="Recover your account">
			<p>
				Enter the email address your account is registered to. Proving you can read that inbox is enough: choose
				a new password below, or have a sign-in link emailed instead if you never set one.
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
				<HumanVerificationField verification={verification} />
				{sent && (
					<p className="form-success" role="status">
						If recovery is available for that address, check its inbox for next steps.
					</p>
				)}
				{displayedError !== null && (
					<p className="form-error" role="alert">
						{displayedError}
					</p>
				)}
				<button type="submit" disabled={blocked}>
					Send recovery email
				</button>
			</form>
			{methods.magicLink && (
				<div className="sign-in-alternatives">
					{/* 🔑 An account made with an emailed link, a passkey, or a provider has no password
					    to reset. Rather than ask that owner to invent one, the link that signs them
					    straight back in is offered here, on the same address and the same widget. */}
					<p className="sign-in-alternatives-divider">Or</p>
					<EmailedSignInLink
						callbackURL={authenticationCallbackPath(oauthQuery, "/")}
						disabled={blocked}
						email={email}
						onError={setError}
						verificationToken={verification.consume}
					/>
				</div>
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

enum PasswordResetPhase {
	Ready,
	Resetting,
	SigningIn,
	SignInFailed,
	ResumingAuthorization,
	AuthorizationResumeFailed,
}

interface ResetPasswordProps extends AccountFormRouteProps, AuthenticationCompletionProps {}

function ResetPassword({onAuthenticated, onNavigate, onOAuthAuthenticated, theme}: ResetPasswordProps): ReactElement {
	const [{invalid, token}] = useState(() => {
		const parameters = new URLSearchParams(window.location.search);
		const initialToken = parameters.get("token");
		return {invalid: parameters.get("error") !== null || initialToken === null, token: initialToken};
	});
	const [oauthQuery] = useState(passwordResetOAuthQuery);
	// Consuming the emailed recovery link is not gated: it already carries a single-use credential.
	// The sign-in that immediately follows it is an ordinary sign-in, and is gated like one.
	const {blocked, discoveryError, verification} = useAccountForm("sign_in", theme);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [authenticatedUser, setAuthenticatedUser] = useState<AuthenticationUser | null>(null);
	const [phase, setPhase] = useState(PasswordResetPhase.Ready);
	const [error, setError] = useState<string | null>(null);
	const displayedError = error ?? discoveryError;

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
			user = await signIn(email, password, await verification.consume());
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
							<HumanVerificationField verification={verification} />
							<button type="submit" disabled={blocked}>
								Try signing in again
							</button>
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
					<HumanVerificationField verification={verification} />
					{displayedError !== null && (
						<p className="form-error" role="alert">
							{displayedError}
						</p>
					)}
					<button type="submit" disabled={phase === PasswordResetPhase.Resetting || blocked}>
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
} as const;

function isOAuthCapability(scope: string): scope is keyof typeof OAUTH_CAPABILITIES {
	return Object.hasOwn(OAUTH_CAPABILITIES, scope);
}

function grantedScopeSummary(scopes: string[]): string {
	return scopes
		.map((scope) => (isOAuthCapability(scope) ? `${OAUTH_CAPABILITIES[scope].label} (${scope})` : scope))
		.join(", ");
}

type OAuthHandoff = "allowed" | "declined";

interface OAuthHandoffPanelProps {
	clientName: string;
	handoff: OAuthHandoff;
}

/**
 * The page that ends an MCP authorization is served by the client's own loopback callback, so this
 * panel is the last surface YepNope owns. The browser is already navigating to the client while it
 * renders; nothing here delays, replaces, or inspects the authorization response.
 */
function OAuthHandoffPanel({clientName, handoff}: OAuthHandoffPanelProps): ReactElement {
	const allowed = handoff === "allowed";
	return (
		<AccountPanel title={allowed ? "Connection authorized" : "Connection declined"}>
			<div className="oauth-handoff" role="status">
				<strong>
					{allowed
						? `YepNope sent your approval back to ${clientName}.`
						: `YepNope told ${clientName} you declined the connection.`}
				</strong>
				<span>
					{allowed
						? `You can close this tab once ${clientName} confirms the connection in your terminal.`
						: "You can close this tab and go back to your terminal."}
				</span>
			</div>
		</AccountPanel>
	);
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
	const [handoff, setHandoff] = useState<OAuthHandoff | null>(null);

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
			if (followOAuthRedirect(await submitOAuthConsent(oauthQuery, accept))) {
				setHandoff(accept ? "allowed" : "declined");
			}
		} catch (caught) {
			setError(errorMessage(caught));
			setSubmitting(false);
		}
	}

	if (handoff !== null) {
		return <OAuthHandoffPanel clientName={client?.name ?? "the MCP client"} handoff={handoff} />;
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

type DeviceAuthorizationOutcome = DeviceAuthorizationDecision | "decided" | "expired" | "not_found";

const DEVICE_AUTHORIZATION_OUTCOMES: Record<
	DeviceAuthorizationOutcome,
	{detail: string; headline: string; title: string}
> = {
	approved: {
		detail: "You can revoke it any time under Settings, Connected MCP clients.",
		headline: "Approved. You can go back to your terminal.",
		title: "Device approved",
	},
	denied: {
		detail: "You can close this tab and go back to your terminal.",
		headline: "Denied. Nothing was connected to your account.",
		title: "Device denied",
	},
	decided: {
		detail: "Run the command again if you still need to connect.",
		headline: "This code was already approved or denied.",
		title: "Code already used",
	},
	expired: {
		detail: "Codes last ten minutes. Run the command again to get a fresh one.",
		headline: "This code has expired.",
		title: "Code expired",
	},
	not_found: {
		detail: "Check the code your terminal printed, or run the command again to get a fresh one.",
		headline: "No pending request matches that code.",
		title: "Code not found",
	},
};

// 🏁 Losing the write race and finding an answer already on file tell the reader the same thing:
// this code has been answered, so stop waiting on this tab.
function deviceOutcomeFromResult(result: DeviceAuthorizationResult): DeviceAuthorizationOutcome {
	if (result.status === "decided") {
		return result.decision;
	}
	return result.status === "expired" || result.status === "not_found" ? result.status : "decided";
}

/**
 * Every way the device grant can end — including the two the account holder chose — is a dead end
 * for this tab: the terminal, not the browser, carries the result forward.
 */
function DeviceAuthorizationOutcomePanel({outcome}: {outcome: DeviceAuthorizationOutcome}): ReactElement {
	const copy = DEVICE_AUTHORIZATION_OUTCOMES[outcome];
	return (
		<AccountPanel title={copy.title}>
			<div className="oauth-handoff" role="status">
				<strong>{copy.headline}</strong>
				<span>{copy.detail}</span>
			</div>
		</AccountPanel>
	);
}

function DeviceAuthorization(): ReactElement {
	const initialUserCode = deviceUserCodeFromLocation();
	const [userCode, setUserCode] = useState(initialUserCode);
	const [authorization, setAuthorization] = useState<PendingDeviceAuthorization | null>(null);
	const [outcome, setOutcome] = useState<DeviceAuthorizationOutcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(initialUserCode !== "");

	const applyLookup = useCallback((lookup: DeviceAuthorizationLookup) => {
		if (lookup.status === "pending") {
			setAuthorization(lookup.authorization);
		} else {
			setOutcome(lookup.status);
		}
		setBusy(false);
	}, []);

	useEffect(() => {
		if (initialUserCode === "") {
			return undefined;
		}
		let cancelled = false;
		fetchDeviceAuthorization(initialUserCode).then(
			(lookup) => {
				if (!cancelled) {
					applyLookup(lookup);
				}
			},
			(caught: unknown) => {
				if (!cancelled) {
					setError(errorMessage(caught));
					setBusy(false);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [applyLookup, initialUserCode]);

	async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			applyLookup(await fetchDeviceAuthorization(userCode));
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	async function decide(decision: DeviceAuthorizationDecision): Promise<void> {
		if (authorization === null) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			setOutcome(deviceOutcomeFromResult(await decideDeviceAuthorization(authorization.userCode, decision)));
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	}

	if (outcome !== null) {
		return <DeviceAuthorizationOutcomePanel outcome={outcome} />;
	}
	if (authorization === null && busy && error === null) {
		return (
			<AccountPanel title="Approve a device">
				<p>Checking the code from your terminal…</p>
			</AccountPanel>
		);
	}
	if (authorization === null) {
		return (
			<AccountPanel title="Approve a device">
				<p>Enter the code your terminal printed. It stays valid for ten minutes.</p>
				<form className="account-form" onSubmit={(event) => void submit(event)}>
					<label>
						Device code
						<input
							type="text"
							name="user_code"
							autoComplete="off"
							autoCapitalize="characters"
							required
							value={userCode}
							onChange={(event) => {
								setUserCode(event.currentTarget.value);
							}}
						/>
					</label>
					{error !== null && (
						<p className="form-error" role="alert">
							{error}
						</p>
					)}
					<button type="submit" disabled={busy}>
						{busy ? "Checking…" : "Continue"}
					</button>
				</form>
			</AccountPanel>
		);
	}

	return (
		<AccountPanel title="Approve a device">
			<p>
				<strong>{authorization.clientName}</strong> printed code <strong>{authorization.userCode}</strong> and
				is waiting for this account to answer.
			</p>
			<ul className="oauth-capabilities">
				{authorization.scopes.map((scope) => (
					<li key={scope}>
						<strong>{isOAuthCapability(scope) ? OAUTH_CAPABILITIES[scope].label : scope}</strong>
						<span>
							{isOAuthCapability(scope)
								? OAUTH_CAPABILITIES[scope].description
								: `Grants the ${scope} scope.`}
						</span>
					</li>
				))}
			</ul>
			<p>
				Approving issues a credential to that device. You can revoke it any time under Settings, Connected MCP
				clients. This code now belongs to your account only, because this page read it first.
			</p>
			{error !== null && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="oauth-actions">
				<button type="button" disabled={busy} onClick={() => void decide("approved")}>
					{busy ? "Responding…" : "Approve"}
				</button>
				<button type="button" className="secondary" disabled={busy} onClick={() => void decide("denied")}>
					Deny
				</button>
			</div>
		</AccountPanel>
	);
}

interface ManagedDeviceRowProps {
	label: string;
	metadata: string;
	onRename?: (label: string) => Promise<void>;
	onRevoke?: () => Promise<void>;
	revokeLabel?: string;
}

function ManagedDeviceRow({
	label,
	metadata,
	onRename,
	onRevoke,
	revokeLabel = "Revoke",
}: ManagedDeviceRowProps): ReactElement {
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
									{revokeLabel}
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

function newPasskeyName(): string {
	return `Passkey added ${new Date().toLocaleDateString()}`;
}

interface SignInMethodsPanelProps {
	onSignedOut: () => void;
}

// 🔐 One place to see every way into this account, and the only place to add or remove one.
function SignInMethodsPanel({onSignedOut}: SignInMethodsPanelProps): ReactElement {
	// This panel is behind a session and adds no method the Worker gates, so discovery stays the
	// enhancement it always was here.
	const methods = alternativeMethods(useAuthenticationMethods());
	const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
	const [passkeys, setPasskeys] = useState<RegisteredPasskey[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const passkeyAvailable = passkeysUsable(methods);

	const reload = useCallback(async (): Promise<void> => {
		const [accounts, credentials] = await Promise.all([fetchLinkedAccounts(), fetchPasskeys()]);
		setLinkedAccounts(accounts);
		setPasskeys(credentials);
	}, []);

	useEffect(() => {
		void reload().catch((caught: unknown) => {
			setError(errorMessage(caught));
		});
	}, [reload]);

	async function run(action: () => Promise<void>): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await action();
			await reload();
		} catch (caught) {
			if (caught instanceof ApiResponseError && (caught.status === 401 || caught.status === 403)) {
				onSignedOut();
				return;
			}
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	}

	function linkedAccountFor(provider: SocialProvider): LinkedAccount | undefined {
		return linkedAccounts.find((account) => account.provider === provider);
	}

	return (
		<div className="hint sign-in-methods" role="region" aria-label="Sign-in methods">
			<h3>Sign-in methods</h3>
			<p>
				Any method listed here signs you into this same account. Keep at least two so losing one device never
				locks you out.
			</p>
			{methods.social.map((provider) => {
				const linked = linkedAccountFor(provider);
				const label = SOCIAL_PROVIDER_LABELS[provider];
				return (
					<button
						key={provider}
						type="button"
						className="secondary"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								if (linked === undefined) {
									followOAuthRedirect(await linkSocialAccount(provider, "/settings"));
									return;
								}
								await unlinkAccount(linked.id);
							})
						}
					>
						{linked === undefined ? "Connect" : "Disconnect"} {label}
					</button>
				);
			})}
			<h4>Passkeys</h4>
			{passkeyAvailable ? (
				<>
					{passkeys.length === 0 ? (
						<p>No passkeys yet. A passkey signs you in with your device unlock instead of a password.</p>
					) : (
						<ul className="device-list">
							{passkeys.map((passkey) => (
								<ManagedDeviceRow
									key={passkey.id}
									label={passkey.name}
									metadata={`Added ${new Date(passkey.createdAt).toLocaleDateString()}`}
									revokeLabel="Remove"
									onRevoke={async () => {
										await run(async () => {
											await deletePasskey(passkey.id);
										});
									}}
								/>
							))}
						</ul>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await registerPasskey(newPasskeyName());
							})
						}
					>
						Add a passkey
					</button>
				</>
			) : (
				<p>This browser cannot use passkeys.</p>
			)}
			{error !== null && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

interface AppearancePanelProps {
	theme: Theme;
}

// 🌗 A native radio group: arrow keys move between the three states, the legend names the group,
// and the checked radio is the state a screen reader reports. No ARIA of our own is needed.
function AppearancePanel({theme}: AppearancePanelProps): ReactElement {
	return (
		<div className="hint appearance" role="region" aria-label="Appearance">
			<h3>Appearance</h3>
			<p>
				Light, dark, or whatever this device is set to. The choice is remembered on this browser only; it is not
				part of your account.
			</p>
			<fieldset className="theme-options">
				<legend>Theme</legend>
				{THEME_CHOICES.map((choice) => (
					<label key={choice.preference} className="theme-option">
						<input
							type="radio"
							name="theme"
							value={choice.preference}
							checked={theme.preference === choice.preference}
							onChange={() => {
								theme.select(choice.preference);
							}}
						/>
						{choice.label}
					</label>
				))}
			</fieldset>
		</div>
	);
}

function Settings({
	session,
	connectedMcpClientCount,
	focusConnectedClients,
	theme,
	onBack,
	onSignIn,
	onRegister,
	onSignedOut,
}: SettingsProps): ReactElement {
	const requiresIosInstall = isIos() && !isStandalone();
	const connectedClientsHeading = useRef<HTMLHeadingElement | null>(null);
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

	useEffect(() => {
		if (focusConnectedClients) {
			connectedClientsHeading.current?.focus();
		}
	}, [focusConnectedClients]);

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
			{session !== null && <SignInMethodsPanel onSignedOut={onSignedOut} />}
			<AppearancePanel theme={theme} />
			<div className="hint connected-clients" role="region" aria-label="Connected MCP clients">
				<h3 ref={connectedClientsHeading} tabIndex={-1}>
					Connected MCP clients
				</h3>
				<p>OAuth-authorized clients can ask questions and manage only the capabilities you approve.</p>
				<p>Follow the steps for the client you run. Nothing here detects it for you.</p>
				{MCP_CLIENT_SETUPS.map((client) => (
					<div key={client.name} className="client-setup">
						<h4>{client.name}</h4>
						<div className="install-steps">
							{client.pluginSteps.map((step) => (
								<InstallCommand key={step.command} command={step.command} label={step.label} />
							))}
						</div>
						<p>{client.authorization}</p>
						<div className="install-steps">
							{client.manualSteps.map((step) => (
								<InstallCommand key={step.command} command={step.command} label={step.label} />
							))}
						</div>
						<p>
							<a href={client.docsUrl} target="_blank" rel="noreferrer">
								{client.docsLabel}
							</a>
						</p>
					</div>
				))}
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
	const theme = useTheme();
	const [session, setSession] = useState<AuthenticationUser | null>(null);
	const [sessionReady, setSessionReady] = useState(false);
	const [currentQuestions, setCurrentQuestions] = useState<DeckQuestion[]>([]);
	const [afk, setAfkState] = useState<boolean | null>(null);
	const [connectedMcpClientCount, setConnectedMcpClientCount] = useState<number | null>(null);
	const [view, setView] = useState<AppView>(() => viewFromPath(window.location.pathname));
	const [connectingClient, setConnectingClient] = useState(false);
	const [oauthResumeFailed, setOAuthResumeFailed] = useState(false);
	const [registrationEmail, setRegistrationEmail] = useState("");
	const [verificationDelivery, setVerificationDelivery] = useState<VerificationDelivery>("idle");
	const currentDeckStream = useRef<CurrentDeckStream | null>(null);

	useEffect(() => {
		function onPopState(): void {
			setOAuthResumeFailed(false);
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
			"forgot-password": "Recover account · YepNope",
			"reset-password": "Choose a password · YepNope",
			"oauth-consent": "Authorize MCP client · YepNope",
			device: "Approve a device · YepNope",
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
		const target = `${pathForView(nextView)}${preserveOAuthQuery ? `?${oauthQuery}` : deviceHandoffQuery(nextView)}`;
		if (`${window.location.pathname}${window.location.search}` !== target) {
			window.history.pushState({}, "", target);
		}
		if (nextView !== "settings") {
			setConnectingClient(false);
		}
		setOAuthResumeFailed(false);
		setView(nextView);
	}

	const showSignedOutLanding = useCallback(() => {
		currentDeckStream.current?.close();
		currentDeckStream.current = null;
		setCurrentQuestions([]);
		setAfkState(null);
		setConnectedMcpClientCount(null);
		setOAuthResumeFailed(false);
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
							if (cancelled) {
								return;
							}
							// Landing on the sign-in form the visitor already satisfied would tell
							// them to do the one thing that cannot help. Their deck plus the notice
							// says what actually happened and who has to retry.
							setOAuthResumeFailed(true);
							window.history.replaceState({}, "", "/");
							setView("deck");
						});
						return;
					}
					const deviceUserCode = deviceUserCodeFromLocation();
					if (user === null && window.location.pathname === "/device") {
						window.history.replaceState({}, "", `/sign-in${deviceHandoffQuery("sign-in")}`);
						setView("sign-in");
					}
					if (
						user !== null &&
						deviceUserCode !== "" &&
						(window.location.pathname === "/sign-in" || window.location.pathname === "/verify-email")
					) {
						window.history.replaceState({}, "", `/device${deviceHandoffQuery("device")}`);
						setView("device");
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
						focusConnectedClients={connectingClient}
						theme={theme}
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
						theme={theme.resolved}
						onNavigate={navigate}
						onAuthenticated={(user) => {
							setSession(user);
							setSessionReady(true);
							navigate(deviceUserCodeFromLocation() === "" ? "settings" : "device");
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
						theme={theme.resolved}
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
						theme={theme.resolved}
						onNavigate={navigate}
					/>
				);
			case "forgot-password":
				return <ForgotPassword theme={theme.resolved} onNavigate={navigate} />;
			case "reset-password":
				return (
					<ResetPassword
						theme={theme.resolved}
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
			case "device":
				if (!sessionReady) {
					return <div className="loading">Checking your session…</div>;
				}
				if (session === null) {
					return <div className="loading">Sign in is required to continue.</div>;
				}
				return <DeviceAuthorization />;
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
								onConnectClient={() => {
									setConnectingClient(true);
									navigate("settings");
								}}
								onToggle={onToggleAfk}
							/>
						)}
						<button
							type="button"
							className="settings-button"
							aria-label={view === "settings" ? "Close settings" : "Settings"}
							onClick={() => {
								navigate(view === "deck" ? "settings" : "deck");
							}}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<line
									x1="4"
									y1="6"
									x2="20"
									y2="6"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								/>
								<line
									x1="4"
									y1="12"
									x2="20"
									y2="12"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								/>
								<line
									x1="4"
									y1="18"
									x2="20"
									y2="18"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								/>
							</svg>
						</button>
					</span>
				</div>
			)}
			{oauthResumeFailed && (
				<p className="form-error app-notice" role="alert">
					{OAUTH_RESUME_FAILED_MESSAGE}
				</p>
			)}
			{currentView()}
		</div>
	);
}
