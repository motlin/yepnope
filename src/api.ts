import {z} from "zod";
import type {DeckQuestion, Disposition} from "./deck";
import {APPLICATION_UPDATE_EVENT} from "./application-updates";

// 🌐 Thin client for the Worker API. Same-origin in production; the dev server proxies /api.

export class ApiResponseError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ApiResponseError";
	}
}

async function requestJson<Schema extends z.ZodType>(
	path: string,
	init: RequestInit,
	schema: Schema,
): Promise<z.infer<Schema>> {
	const response = await fetch(path, {credentials: "same-origin", ...init});
	if (!response.ok) {
		const error = z.object({message: z.string()}).safeParse(
			await response
				.clone()
				.json()
				.catch(() => null),
		);
		throw new ApiResponseError(
			error.success ? error.data.message : `${init.method ?? "GET"} ${path} failed with ${response.status}`,
			response.status,
		);
	}
	const body: unknown = await response.json();
	return schema.parse(body);
}

function jsonRequest(body: Record<string, unknown>): RequestInit {
	return {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(body),
	};
}

const authenticationUserSchema = z.object({
	id: z.string(),
	email: z.email(),
	emailVerified: z.boolean(),
});

export type AuthenticationUser = z.infer<typeof authenticationUserSchema>;

const sessionResponseSchema = z.object({user: authenticationUserSchema}).nullable();

export async function fetchSession(): Promise<AuthenticationUser | null> {
	const session = await requestJson("/api/auth/get-session", {cache: "no-store"}, sessionResponseSchema);
	return session?.user ?? null;
}

const authenticatedResponseSchema = z.object({user: authenticationUserSchema});
const PUBLIC_SIGN_IN_FAILURE_MESSAGE = "Sign-in failed. Check your email and password, or recover your account.";

async function requestSignIn<Schema extends z.ZodType>(
	body: Record<string, unknown>,
	schema: Schema,
): Promise<z.infer<Schema>> {
	try {
		return await requestJson("/api/auth/sign-in/email", jsonRequest(body), schema);
	} catch (caught) {
		if (caught instanceof ApiResponseError && [400, 401, 403].includes(caught.status)) {
			throw new ApiResponseError(PUBLIC_SIGN_IN_FAILURE_MESSAGE, 401);
		}
		throw caught;
	}
}

export async function signIn(email: string, password: string): Promise<AuthenticationUser> {
	const result = await requestSignIn({email, password}, authenticatedResponseSchema);
	return result.user;
}

const oauthRedirectResponseSchema = z.object({redirect: z.boolean(), url: z.string().min(1)});

function normalizedOAuthRedirectUrl(value: string): string {
	const target = new URL(value, window.location.origin);
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new TypeError("OAuth redirect must use HTTP or HTTPS");
	}
	return target.href;
}

export async function signInForOAuth(email: string, password: string, oauthQuery: string): Promise<string> {
	const result = await requestSignIn(
		{
			callbackURL: `/sign-in?${oauthQuery}`,
			email,
			oauth_query: oauthQuery,
			password,
		},
		oauthRedirectResponseSchema,
	);
	return normalizedOAuthRedirectUrl(result.url);
}

export async function resumeOAuthAuthorization(oauthQuery: string): Promise<string> {
	const result = await requestJson(
		`/api/auth/oauth2/authorize?${oauthQuery}`,
		{headers: {Accept: "application/json"}},
		oauthRedirectResponseSchema,
	);
	return normalizedOAuthRedirectUrl(result.url);
}

const oauthClientResponseSchema = z.object({
	client_id: z.string(),
	client_name: z.string().optional(),
	client_uri: z.url().optional(),
});

export interface OAuthClientSummary {
	id: string;
	name: string;
	uri: string | null;
}

export async function fetchOAuthClient(clientId: string): Promise<OAuthClientSummary> {
	const result = await requestJson(
		`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
		{},
		oauthClientResponseSchema,
	);
	return {id: result.client_id, name: result.client_name ?? "MCP client", uri: result.client_uri ?? null};
}

export async function submitOAuthConsent(oauthQuery: string, accept: boolean): Promise<string> {
	const result = await requestJson(
		"/api/auth/oauth2/consent",
		jsonRequest({accept, oauth_query: oauthQuery}),
		oauthRedirectResponseSchema,
	);
	return normalizedOAuthRedirectUrl(result.url);
}

export async function registerAccount(email: string, password: string, callbackURL = "/verify-email"): Promise<void> {
	await requestJson(
		"/api/auth/sign-up/email",
		jsonRequest({email, password, callbackURL}),
		publicAuthenticationAcceptedResponseSchema,
	);
}

const publicAuthenticationAcceptedResponseSchema = z
	.object({
		message: z.literal("If the request can be completed, check your inbox for next steps."),
		status: z.literal(true),
	})
	.strict();
const successResponseSchema = z.object({status: z.literal(true)}).strict();

export async function sendVerificationEmail(email: string, callbackURL = "/verify-email"): Promise<void> {
	await requestJson(
		"/api/auth/send-verification-email",
		jsonRequest({email, callbackURL}),
		publicAuthenticationAcceptedResponseSchema,
	);
}

export async function requestPasswordReset(email: string): Promise<void> {
	await requestJson(
		"/api/auth/request-password-reset",
		jsonRequest({email, redirectTo: "/reset-password"}),
		publicAuthenticationAcceptedResponseSchema,
	);
}

export async function consumePasswordResetToken(token: string, newPassword: string): Promise<void> {
	await requestJson("/api/auth/reset-password", jsonRequest({token, newPassword}), successResponseSchema);
}

export async function signOut(): Promise<void> {
	await requestJson("/api/auth/sign-out", jsonRequest({}), z.object({success: z.literal(true)}));
}

const legacyIdentityClaimResponseSchema = z.object({
	status: z.literal("claimed"),
	already_claimed: z.boolean(),
});

export async function claimLegacyIdentity(legacyToken: string): Promise<void> {
	await requestJson(
		"/api/v1/account/claim-legacy",
		jsonRequest({legacy_token: legacyToken}),
		legacyIdentityClaimResponseSchema,
	);
}

const managedConnectedMcpClientSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	authorized_at: z.number(),
	last_used_at: z.number().nullable(),
	granted_scopes: z.array(z.string()),
	status: z.enum(["active", "expired", "revoked"]),
	revoked_at: z.number().nullable(),
});

const managedPushDeviceSchema = z.object({
	id: z.string(),
	label: z.string(),
	created_at: z.number(),
});

const managedBrowserSessionSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	created_at: z.number(),
	last_active_at: z.number(),
	expires_at: z.number(),
	current: z.boolean(),
});

const accountDevicesResponseSchema = z.object({
	browser_sessions: z.array(managedBrowserSessionSchema),
	connected_mcp_clients: z.array(managedConnectedMcpClientSchema),
	push_devices: z.array(managedPushDeviceSchema),
});

export interface ManagedConnectedMcpClient {
	id: string;
	displayName: string;
	authorizedAt: number;
	lastUsedAt: number | null;
	grantedScopes: string[];
	status: "active" | "expired" | "revoked";
	revokedAt: number | null;
}

export interface ManagedPushDevice {
	id: string;
	label: string;
	createdAt: number;
}

export interface ManagedBrowserSession {
	id: string;
	displayName: string;
	createdAt: number;
	lastActiveAt: number;
	expiresAt: number;
	current: boolean;
}

export interface AccountDevices {
	browserSessions: ManagedBrowserSession[];
	connectedMcpClients: ManagedConnectedMcpClient[];
	pushDevices: ManagedPushDevice[];
}

export async function fetchAccountDevices(): Promise<AccountDevices> {
	const body = await requestJson("/api/v1/account/devices", {}, accountDevicesResponseSchema);
	return {
		browserSessions: body.browser_sessions.map((browserSession) => ({
			id: browserSession.id,
			displayName: browserSession.display_name,
			createdAt: browserSession.created_at,
			lastActiveAt: browserSession.last_active_at,
			expiresAt: browserSession.expires_at,
			current: browserSession.current,
		})),
		connectedMcpClients: body.connected_mcp_clients.map((client) => ({
			id: client.id,
			displayName: client.display_name,
			authorizedAt: client.authorized_at,
			lastUsedAt: client.last_used_at,
			grantedScopes: client.granted_scopes,
			status: client.status,
			revokedAt: client.revoked_at,
		})),
		pushDevices: body.push_devices.map((device) => ({
			id: device.id,
			label: device.label,
			createdAt: device.created_at,
		})),
	};
}

const revokeConnectedMcpClientResponseSchema = z.object({
	status: z.literal("ok"),
	connected_mcp_client_count: z.number().int().nonnegative(),
});

export async function revokeConnectedMcpClient(connectedMcpClientId: string): Promise<number> {
	const body = await requestJson(
		`/api/v1/account/connected-mcp-clients/${connectedMcpClientId}`,
		{method: "DELETE"},
		revokeConnectedMcpClientResponseSchema,
	);
	return body.connected_mcp_client_count;
}

export async function renamePushDevice(deviceId: string, label: string): Promise<void> {
	await requestJson(
		`/api/v1/account/push-devices/${deviceId}`,
		{method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({label})},
		okResponseSchema,
	);
}

export async function revokePushDevice(deviceId: string): Promise<void> {
	await requestJson(`/api/v1/account/push-devices/${deviceId}`, {method: "DELETE"}, okResponseSchema);
}

const questionSchema = z.object({
	batch_id: z.string(),
	project: z.string(),
	repo: z.string().nullable(),
	branch: z.string().nullable(),
	directory: z.string().nullable(),
	question_id: z.string(),
	position: z.number(),
	title: z.string(),
	body: z.string(),
	created_at: z.number(),
});

const currentDeckStateSchema = z.object({
	type: z.literal("current_deck"),
	afk: z.boolean(),
	connected_mcp_client_count: z.number().int().nonnegative(),
	current_deck: z.array(questionSchema),
});

function toDeckQuestions(questions: z.infer<typeof questionSchema>[]): DeckQuestion[] {
	return questions.map((question) => ({
		questionId: question.question_id,
		batchId: question.batch_id,
		project: question.project,
		repo: question.repo,
		branch: question.branch,
		directory: question.directory,
		title: question.title,
		body: question.body,
	}));
}

export interface CurrentDeckStream {
	close: () => void;
	refresh: () => void;
	state: () => CurrentDeckConnectionState;
}

export enum CurrentDeckConnectionState {
	CircuitOpen = "circuit-open",
	Connecting = "connecting",
	Open = "open",
	Paused = "paused",
	Stopped = "stopped",
	Waiting = "waiting",
}

export interface CurrentDeckStreamOptions {
	initialReconnectDelayMilliseconds?: number;
	maximumConsecutiveFailures?: number;
	maximumReconnectDelayMilliseconds?: number;
	onSignedOut?: () => void;
	random?: () => number;
	sessionRevalidationFailureCount?: number;
}

export interface LiveApplicationState {
	afk: boolean;
	connectedMcpClientCount: number;
	currentDeck: DeckQuestion[];
}

const INITIAL_RECONNECT_DELAY_MILLISECONDS = 250;
const MAXIMUM_RECONNECT_DELAY_MILLISECONDS = 2_000;
const MAXIMUM_CONSECUTIVE_FAILURES = 5;
const SESSION_REVALIDATION_FAILURE_COUNT = 3;

enum StreamAccess {
	Available,
	SignedOut,
	Unknown,
	Unsupported,
}

async function revalidateCurrentDeckStreamAccess(): Promise<StreamAccess> {
	const user = await fetchSession();
	if (user === null) {
		return StreamAccess.SignedOut;
	}
	const response = await fetch("/api/v1/current-deck/stream", {credentials: "same-origin"});
	if (response.status === 401 || response.status === 403) {
		return StreamAccess.SignedOut;
	}
	if ([404, 405, 410, 501].includes(response.status)) {
		return StreamAccess.Unsupported;
	}
	return response.ok || response.status === 426 ? StreamAccess.Available : StreamAccess.Unknown;
}

function reconnectDelay(
	consecutiveFailures: number,
	initialDelayMilliseconds: number,
	maximumDelayMilliseconds: number,
	random: () => number,
): number {
	const exponentialDelay = Math.min(
		maximumDelayMilliseconds,
		initialDelayMilliseconds * 2 ** (consecutiveFailures - 1),
	);
	const jitteredDelay = exponentialDelay * (0.75 + random() * 0.5);
	return Math.round(Math.min(maximumDelayMilliseconds, jitteredDelay));
}

export function openCurrentDeckStream(
	onState: (state: LiveApplicationState) => void,
	options: CurrentDeckStreamOptions = {},
): CurrentDeckStream {
	let socket: WebSocket | null = null;
	let reconnectTimer: number | undefined;
	let stopped = false;
	let circuitOpen = false;
	let consecutiveFailures = 0;
	let accessRevalidated = false;
	let connectionState = CurrentDeckConnectionState.Connecting;
	let failureSequence = 0;
	const initialDelayMilliseconds = options.initialReconnectDelayMilliseconds ?? INITIAL_RECONNECT_DELAY_MILLISECONDS;
	const maximumDelayMilliseconds = options.maximumReconnectDelayMilliseconds ?? MAXIMUM_RECONNECT_DELAY_MILLISECONDS;
	const maximumConsecutiveFailures = options.maximumConsecutiveFailures ?? MAXIMUM_CONSECUTIVE_FAILURES;
	const sessionRevalidationFailureCount =
		options.sessionRevalidationFailureCount ?? SESSION_REVALIDATION_FAILURE_COUNT;
	const random = options.random ?? Math.random;

	function shouldPause(): boolean {
		return !navigator.onLine || document.visibilityState !== "visible";
	}

	function clearReconnectTimer(): void {
		if (reconnectTimer !== undefined) {
			window.clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
	}

	function stop(nextState: CurrentDeckConnectionState): void {
		stopped = true;
		connectionState = nextState;
		failureSequence += 1;
		clearReconnectTimer();
		const activeSocket = socket;
		socket = null;
		activeSocket?.close();
		window.removeEventListener("online", onOnline);
		window.removeEventListener("offline", onOffline);
		window.removeEventListener("pagehide", onPageHide);
		window.removeEventListener(APPLICATION_UPDATE_EVENT, onApplicationUpdate);
		document.removeEventListener("visibilitychange", onVisibilityChange);
	}

	function openCircuit(): void {
		circuitOpen = true;
		connectionState = CurrentDeckConnectionState.CircuitOpen;
		clearReconnectTimer();
	}

	function scheduleReconnect(): void {
		if (stopped || circuitOpen || socket !== null || reconnectTimer !== undefined) {
			return;
		}
		if (shouldPause()) {
			connectionState = CurrentDeckConnectionState.Paused;
			return;
		}
		connectionState = CurrentDeckConnectionState.Waiting;
		reconnectTimer = window.setTimeout(
			() => {
				reconnectTimer = undefined;
				connect();
			},
			reconnectDelay(consecutiveFailures, initialDelayMilliseconds, maximumDelayMilliseconds, random),
		);
	}

	async function handleConnectionFailure(): Promise<void> {
		consecutiveFailures += 1;
		const sequence = ++failureSequence;
		if (consecutiveFailures >= sessionRevalidationFailureCount && !accessRevalidated) {
			let access = StreamAccess.Unknown;
			try {
				access = await revalidateCurrentDeckStreamAccess();
			} catch {
				access = StreamAccess.Unknown;
			}
			if (stopped || sequence !== failureSequence) {
				return;
			}
			if (access === StreamAccess.SignedOut) {
				stop(CurrentDeckConnectionState.Stopped);
				options.onSignedOut?.();
				return;
			}
			if (access === StreamAccess.Unsupported) {
				openCircuit();
				return;
			}
			accessRevalidated = access === StreamAccess.Available;
		}
		if (consecutiveFailures >= maximumConsecutiveFailures) {
			openCircuit();
			return;
		}
		scheduleReconnect();
	}

	function connect(): void {
		if (stopped || circuitOpen || socket !== null) {
			return;
		}
		if (shouldPause()) {
			connectionState = CurrentDeckConnectionState.Paused;
			return;
		}
		connectionState = CurrentDeckConnectionState.Connecting;
		const url = new URL("/api/v1/current-deck/stream", window.location.href);
		url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const connection = new WebSocket(url);
		socket = connection;
		let settled = false;
		connection.addEventListener("open", () => {
			connectionState = CurrentDeckConnectionState.Open;
		});
		connection.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				throw new Error("question stream sent a non-text frame");
			}
			const state = currentDeckStateSchema.parse(JSON.parse(event.data) as unknown);
			consecutiveFailures = 0;
			accessRevalidated = false;
			failureSequence += 1;
			connectionState = CurrentDeckConnectionState.Open;
			onState({
				afk: state.afk,
				connectedMcpClientCount: state.connected_mcp_client_count,
				currentDeck: toDeckQuestions(state.current_deck),
			});
		});
		connection.addEventListener("close", () => {
			if (settled) {
				return;
			}
			settled = true;
			if (socket === connection) {
				socket = null;
			}
			if (!stopped) {
				void handleConnectionFailure();
			}
		});
	}

	function resume(): void {
		if (stopped || circuitOpen || shouldPause()) {
			return;
		}
		if (socket === null && reconnectTimer === undefined) {
			connect();
		}
	}

	function onOnline(): void {
		resume();
	}

	function onOffline(): void {
		clearReconnectTimer();
		if (socket === null) {
			connectionState = CurrentDeckConnectionState.Paused;
		}
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === "visible") {
			resume();
			return;
		}
		clearReconnectTimer();
		if (socket === null) {
			connectionState = CurrentDeckConnectionState.Paused;
		}
	}

	function onPageHide(): void {
		stop(CurrentDeckConnectionState.Stopped);
	}

	function onApplicationUpdate(): void {
		stop(CurrentDeckConnectionState.Stopped);
	}

	window.addEventListener("online", onOnline);
	window.addEventListener("offline", onOffline);
	window.addEventListener("pagehide", onPageHide);
	window.addEventListener(APPLICATION_UPDATE_EVENT, onApplicationUpdate);
	document.addEventListener("visibilitychange", onVisibilityChange);
	connect();
	return {
		close: () => {
			stop(CurrentDeckConnectionState.Stopped);
		},
		refresh: () => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send("state");
				return;
			}
			if (stopped) {
				return;
			}
			circuitOpen = false;
			consecutiveFailures = 0;
			accessRevalidated = false;
			failureSequence += 1;
			clearReconnectTimer();
			resume();
		},
		state: () => connectionState,
	};
}

const okResponseSchema = z.object({status: z.string()});

export async function submitAnswer(questionId: string, disposition: Disposition): Promise<void> {
	await requestJson(
		"/api/v1/answers",
		{
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({answers: [{question_id: questionId, disposition}]}),
		},
		okResponseSchema,
	);
}

const afkResponseSchema = z.object({afk: z.boolean()});

export async function fetchAfk(): Promise<boolean> {
	const body = await requestJson("/api/v1/afk", {}, afkResponseSchema);
	return body.afk;
}

export async function updateAfk(afk: boolean): Promise<boolean> {
	const body = await requestJson(
		"/api/v1/afk",
		{method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({afk})},
		afkResponseSchema,
	);
	return body.afk;
}

const publicKeyResponseSchema = z.object({public_key: z.string()});

export async function fetchVapidPublicKey(): Promise<string> {
	const body = await requestJson("/api/v1/push/public-key", {}, publicKeyResponseSchema);
	return body.public_key;
}

export async function registerPushSubscription(subscription: unknown): Promise<void> {
	await requestJson(
		"/api/v1/push/subscribe",
		{method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(subscription)},
		okResponseSchema,
	);
}
