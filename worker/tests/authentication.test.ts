import {env} from "cloudflare:workers";
import {SignJWT} from "jose";
import {describe, expect, it} from "vitest";
import {createAuthentication, hashToken, type AuthenticationObservation} from "../auth";
import {
	API_ORIGIN,
	AUTHENTICATION_PASSWORD,
	authenticationWithMailbox,
	cookieFrom,
	emailLink,
	humanVerified,
	immediatePublicAuthenticationTiming,
	postAuthentication,
	required,
	worker,
	type DeliveredAuthenticationEmail,
} from "./helpers";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function emailLinks(html: string): Array<{href: string; label: string}> {
	return Array.from(html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g), ([, href, label]) => ({
		href: required(href, "email link href"),
		label: required(label, "email link label"),
	}));
}

function emailLayout(html: string) {
	return {
		cardStyle: required(
			/<table role="presentation" width="100%"[^>]+style="(width:100%;max-width:560px;[^"]+)"/.exec(html)?.[1],
			"responsive email card style",
		),
		externalAssets: Array.from(html.matchAll(/(?:background|src)="(https?:\/\/[^"\s]+)"/g), ([, url]) =>
			required(url, "external email asset URL"),
		),
		styleElements: Array.from(html.matchAll(/<style[^>]*>/g), ([element]) => element),
		viewport: required(/<meta name="viewport" content="([^"]+)">/.exec(html)?.[1], "email viewport"),
	};
}

function emailCopy(html: string) {
	return {
		expiration: required(/<p style="margin:24px 0 0;[^"]+">([^<]+)<\/p>/.exec(html)?.[1], "email expiration copy"),
		heading: required(/<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1], "email heading"),
		introduction: required(/<p style="margin:0 0 24px;[^"]+">([^<]+)<\/p>/.exec(html)?.[1], "email introduction"),
		preheader: required(/<div style="display:none;[^"]+">([^<]+)<\/div>/.exec(html)?.[1], "email preheader"),
		safety: required(/<p style="margin:20px 0 0;[^"]+">([^<]+)<\/p>/.exec(html)?.[1], "email safety copy"),
	};
}

// 🎟️ Better Auth's verification link is a stateless JWT; the single-use row this Worker mints
// alongside it is what makes a link consumable exactly once, so it is the token state worth counting.
async function verificationTokenCount(email: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT count(*) AS tokens FROM verification " +
			"WHERE identifier LIKE 'yepnope-email-verification:%' " +
			"AND value = (SELECT id FROM user WHERE email = ?)",
	)
		.bind(email)
		.first<{tokens: number}>();
	if (row === null) {
		throw new Error("missing verification token count");
	}
	return row.tokens;
}

// 📮 Cloudflare Email Service rejects with a plain Error carrying a documented string `code`.
function emailServiceError(code: string, message: string): Error {
	return Object.assign(new Error(message), {code});
}

async function publicContract(responsePromise: Promise<Response>) {
	const response = await responsePromise;
	return {
		body: await response.json(),
		cacheControl: response.headers.get("cache-control"),
		contentType: response.headers.get("content-type"),
		location: response.headers.get("location"),
		setCookie: response.headers.get("set-cookie"),
		status: response.status,
	};
}

describe("Better Auth account recovery", () => {
	it("deduplicates concurrent account onboarding without minting browser credentials", async () => {
		const {authentication} = authenticationWithMailbox();
		const requests = Array.from({length: 10}, async () =>
			authentication.handler(
				postAuthentication("sign-up/email", {
					callbackURL: "/",
					email: "concurrent-alice@example.com",
					password: AUTHENTICATION_PASSWORD,
				}),
			),
		);

		await Promise.all(requests);
		expect(
			await env.DB.prepare(
				"SELECT (SELECT count(*) FROM user) AS users, " +
					"(SELECT count(*) FROM account) AS accounts, " +
					"(SELECT count(*) FROM identity_lifecycles) AS identities, " +
					"(SELECT count(*) FROM oauth_client) AS oauth_clients",
			).first(),
		).toStrictEqual({accounts: 1, identities: 1, oauth_clients: 0, users: 1});
	});

	it("registers with only email and password and never stores or returns a display name", async () => {
		const {authentication} = authenticationWithMailbox();
		const email = "alice@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {email, password: AUTHENTICATION_PASSWORD}),
		);

		expect({body: await signUp.json(), status: signUp.status}).toStrictEqual({
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			status: 200,
		});
		expect(await env.DB.prepare("SELECT email, name FROM user WHERE email = ?").bind(email).first()).toStrictEqual({
			email,
			name: null,
		});

		const namedSignUp = await authentication.handler(
			postAuthentication("sign-up/email", {
				email: "bob@example.com",
				name: "Bob",
				password: AUTHENTICATION_PASSWORD,
			}),
		);
		expect({body: await namedSignUp.json(), status: namedSignUp.status}).toStrictEqual({
			body: {
				code: "INVALID_REGISTRATION_REQUEST",
				message: "Registration requires an email and password",
			},
			status: 400,
		});
		expect(
			await env.DB.prepare("SELECT count(*) AS users FROM user WHERE email = ?").bind("bob@example.com").first(),
		).toStrictEqual({users: 0});
	});

	// The absent requireLocalEmailVerified above is deliberate: its default keeps a pre-registered
	// unverified local row from absorbing a victim's social identity on that provider's first sign-in.
	it("links only provider identities that resolve to the same verified email account", () => {
		const {authentication} = authenticationWithMailbox();
		const accountOptions = authentication.options.account;
		if (accountOptions === undefined) {
			throw new Error("authentication account options are missing");
		}
		expect(accountOptions.accountLinking).toStrictEqual({
			allowDifferentEmails: false,
			disableImplicitLinking: false,
			enabled: true,
			trustedProviders: [],
		});
	});

	it("keeps verification resend responses generic for unknown email addresses", async () => {
		const {authentication, mailbox} = authenticationWithMailbox();
		const email = "generic-alice@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {email, password: AUTHENTICATION_PASSWORD}),
		);
		expect(signUp.status).toBe(200);

		const existing = await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
		);
		const missing = await authentication.handler(
			postAuthentication("send-verification-email", {
				callbackURL: "/verify-email",
				email: "missing-alice@example.com",
			}),
		);
		expect([
			{body: await existing.json(), status: existing.status},
			{body: await missing.json(), status: missing.status},
		]).toStrictEqual([
			{
				body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
				status: 200,
			},
			{
				body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
				status: 200,
			},
		]);
		expect(mailbox.map(({subject, to}) => ({subject, to}))).toStrictEqual([
			{subject: "Verify your YepNope email", to: email},
		]);
	});

	it("keeps every public account-state contract indistinguishable", async () => {
		const {authentication, mailbox, publicAuthenticationWaits} = authenticationWithMailbox();
		const password = AUTHENTICATION_PASSWORD;
		const unverifiedEmail = "unverified-contract-alice@example.com";
		const verifiedEmail = "verified-contract-alice@example.com";
		const newRegistrationEmail = "new-registration-contract-alice@example.com";
		const unknownEmail = "unknown-contract-alice@example.com";

		for (const email of [unverifiedEmail, verifiedEmail]) {
			await authentication.handler(postAuthentication("sign-up/email", {email, password}));
		}
		await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email: verifiedEmail}),
		);
		await authentication.handler(new Request(emailLink(required(mailbox[0], "verification email"))));
		mailbox.length = 0;
		publicAuthenticationWaits.length = 0;

		const registrations = await Promise.all(
			[newRegistrationEmail, unverifiedEmail, verifiedEmail].map(async (email) =>
				publicContract(authentication.handler(postAuthentication("sign-up/email", {email, password}))),
			),
		);
		const acceptedContract = {
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			cacheControl: "no-store",
			contentType: "application/json",
			location: null,
			setCookie: null,
			status: 200,
		};
		expect(registrations).toStrictEqual([acceptedContract, acceptedContract, acceptedContract]);

		const signIns = await Promise.all(
			[
				{email: unknownEmail, password: "wrong-password"},
				{email: unverifiedEmail, password: "wrong-password"},
				{email: verifiedEmail, password: "wrong-password"},
			].map(async (credentials) =>
				publicContract(authentication.handler(postAuthentication("sign-in/email", credentials))),
			),
		);
		const signInFailureContract = {
			body: {
				code: "AUTHENTICATION_FAILED",
				message: "Sign-in failed. Check your email and password, or recover your account.",
			},
			cacheControl: "no-store",
			contentType: "application/json",
			location: null,
			setCookie: null,
			status: 401,
		};
		expect(signIns).toStrictEqual([signInFailureContract, signInFailureContract, signInFailureContract]);

		const verificationRequests = await Promise.all(
			[unknownEmail, unverifiedEmail, verifiedEmail].map(async (email) =>
				publicContract(
					authentication.handler(
						postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
					),
				),
			),
		);
		expect(verificationRequests).toStrictEqual([acceptedContract, acceptedContract, acceptedContract]);
		expect(mailbox.map(({subject, to}) => ({subject, to}))).toStrictEqual([
			{subject: "Verify your YepNope email", to: unverifiedEmail},
		]);
		mailbox.length = 0;

		const passwordRecoveryRequests = await Promise.all(
			[unknownEmail, unverifiedEmail, verifiedEmail].map(async (email) =>
				publicContract(
					authentication.handler(
						postAuthentication("request-password-reset", {email, redirectTo: "/reset-password"}),
					),
				),
			),
		);
		expect(passwordRecoveryRequests).toStrictEqual([acceptedContract, acceptedContract, acceptedContract]);
		expect(
			mailbox
				.map(({subject, to}) => ({subject, to}))
				.sort((left, right) => String(left.to).localeCompare(String(right.to))),
		).toStrictEqual([
			{subject: "Reset your YepNope password", to: unverifiedEmail},
			{subject: "Reset your YepNope password", to: verifiedEmail},
		]);

		expect(publicAuthenticationWaits).toHaveLength(12);
		expect(Math.min(...publicAuthenticationWaits)).toBeGreaterThanOrEqual(450);
		expect(Math.max(...publicAuthenticationWaits) - Math.min(...publicAuthenticationWaits)).toBeLessThan(500);
	});

	it("suppresses delivery failures without recording their sensitive details", async () => {
		const email = "delivery-failure-alice@example.com";
		const password = AUTHENTICATION_PASSWORD;
		await authenticationWithMailbox().authentication.handler(
			postAuthentication("sign-up/email", {email, password}),
		);
		const observations: AuthenticationObservation[] = [];
		const attempts: number[] = [];
		let deliveries = 0;
		const authentication = createAuthentication(env, {
			observe: (observation) => {
				observations.push(observation);
			},
			publicAuthenticationTiming: immediatePublicAuthenticationTiming,
			runInBackground: undefined,
			verifyHuman: humanVerified,
			sendEmail: async () => {
				deliveries += 1;
				return Promise.reject(
					emailServiceError(
						"E_RECIPIENT_NOT_ALLOWED",
						"delivery-failure-alice@example.com is not a verified destination address for " +
							"https://yepnope.app/api/auth/verify-email?token=test-secret",
					),
				);
			},
		});
		const responses = [
			await publicContract(
				authentication.handler(
					postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
				),
			),
			await publicContract(
				authentication.handler(
					postAuthentication("request-password-reset", {email, redirectTo: "/reset-password"}),
				),
			),
		];
		attempts.push(deliveries);
		const acceptedContract = {
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			cacheControl: "no-store",
			contentType: "application/json",
			location: null,
			setCookie: null,
			status: 200,
		};

		expect(responses).toStrictEqual([acceptedContract, acceptedContract]);
		expect({
			// 🔁 A rejected recipient cannot become an accepted one, so neither request is retried.
			attempts,
			observations,
			serializedContainsSensitiveMaterial:
				JSON.stringify(observations).includes(email) || JSON.stringify(observations).includes("test-secret"),
		}).toStrictEqual({
			attempts: [2],
			observations: [
				{
					event: "authentication_verification_state_classified",
					failure: null,
					level: "info",
					reason: "unverified_account",
					status: null,
				},
				{
					event: "authentication_email_delivery_failed",
					failure: "recipient_rejected",
					level: "error",
					reason: "request_verification",
					status: null,
				},
				{
					event: "public_authentication_response_normalized",
					failure: null,
					level: "info",
					reason: "request_verification",
					status: 200,
				},
				{
					event: "authentication_email_delivery_failed",
					failure: "recipient_rejected",
					level: "error",
					reason: "request_password_recovery",
					status: null,
				},
				{
					event: "public_authentication_response_normalized",
					failure: null,
					level: "info",
					reason: "request_password_recovery",
					status: 200,
				},
			],
			serializedContainsSensitiveMaterial: false,
		});
	});

	it("retries a transient delivery failure without minting a second verification token", async () => {
		const email = "transient-delivery-alice@example.com";
		const password = AUTHENTICATION_PASSWORD;
		await authenticationWithMailbox().authentication.handler(
			postAuthentication("sign-up/email", {email, password}),
		);
		const observations: AuthenticationObservation[] = [];
		const mailbox: DeliveredAuthenticationEmail[] = [];
		let deliveries = 0;
		const authentication = createAuthentication(env, {
			observe: (observation) => {
				observations.push(observation);
			},
			publicAuthenticationTiming: immediatePublicAuthenticationTiming,
			runInBackground: undefined,
			verifyHuman: humanVerified,
			sendEmail: async (message) => {
				deliveries += 1;
				if (deliveries === 1) {
					return Promise.reject(emailServiceError("E_INTERNAL_SERVER_ERROR", "Email Service is unavailable"));
				}
				mailbox.push({
					from: message.from,
					html: required(message.html, "email HTML"),
					subject: message.subject,
					text: required(message.text, "email text"),
					to: required(message.to, "email recipient"),
				});
				return Promise.resolve();
			},
		});

		const request = await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
		);

		expect({
			body: await request.json(),
			deliveries,
			messages: mailbox.map(({subject, to}) => ({subject, to})),
			observations,
			tokens: await verificationTokenCount(email),
		}).toStrictEqual({
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			deliveries: 2,
			messages: [{subject: "Verify your YepNope email", to: email}],
			observations: [
				{
					event: "authentication_verification_state_classified",
					failure: null,
					level: "info",
					reason: "unverified_account",
					status: null,
				},
				{
					event: "authentication_email_delivery_retried",
					failure: "transient",
					level: "warn",
					reason: "request_verification",
					status: null,
				},
				{
					event: "authentication_email_delivered",
					failure: null,
					level: "info",
					reason: "request_verification",
					status: null,
				},
				{
					event: "public_authentication_response_normalized",
					failure: null,
					level: "info",
					reason: "request_verification",
					status: 200,
				},
			],
			tokens: 1,
		});
	});

	it("bounds retries when every delivery attempt keeps failing transiently", async () => {
		const email = "transient-exhausted-alice@example.com";
		const password = AUTHENTICATION_PASSWORD;
		await authenticationWithMailbox().authentication.handler(
			postAuthentication("sign-up/email", {email, password}),
		);
		const observations: AuthenticationObservation[] = [];
		let deliveries = 0;
		const authentication = createAuthentication(env, {
			observe: (observation) => {
				observations.push(observation);
			},
			publicAuthenticationTiming: immediatePublicAuthenticationTiming,
			runInBackground: undefined,
			verifyHuman: humanVerified,
			sendEmail: async () => {
				deliveries += 1;
				return Promise.reject(emailServiceError("E_DELIVERY_FAILED", "recipient server rejected the message"));
			},
		});

		await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
		);

		const retried = {
			event: "authentication_email_delivery_retried",
			failure: "transient",
			level: "warn",
			reason: "request_verification",
			status: null,
		};
		expect({
			deliveries,
			deliveryObservations: observations.filter(({event}) => event.startsWith("authentication_email_")),
			// 🎟️ Every attempt reuses the one token minted before the first send.
			tokens: await verificationTokenCount(email),
		}).toStrictEqual({
			deliveries: 3,
			deliveryObservations: [
				retried,
				retried,
				{
					event: "authentication_email_delivery_failed",
					failure: "transient",
					level: "error",
					reason: "request_verification",
					status: null,
				},
			],
			tokens: 1,
		});
	});

	it("never retries a delivery another attempt cannot fix", async () => {
		// 🚫 A domain that was never onboarded to Cloudflare Email Service, a suppressed or
		// unverified recipient, and an exhausted quota all stay rejected however often they are tried.
		const terminalRejections = [
			{code: "E_SENDER_DOMAIN_NOT_AVAILABLE", failure: "sender_rejected"},
			{code: "E_RECIPIENT_SUPPRESSED", failure: "recipient_rejected"},
			{code: "E_DAILY_LIMIT_EXCEEDED", failure: "throttled"},
			{code: "E_VALIDATION_ERROR", failure: "message_rejected"},
		];
		const password = AUTHENTICATION_PASSWORD;
		const outcomes = [];
		for (const [index, rejection] of terminalRejections.entries()) {
			const email = `terminal-delivery-${index}-alice@example.com`;
			await authenticationWithMailbox().authentication.handler(
				postAuthentication("sign-up/email", {email, password}),
			);
			const observations: AuthenticationObservation[] = [];
			let deliveries = 0;
			const authentication = createAuthentication(env, {
				observe: (observation) => {
					observations.push(observation);
				},
				publicAuthenticationTiming: immediatePublicAuthenticationTiming,
				runInBackground: undefined,
				verifyHuman: humanVerified,
				sendEmail: async () => {
					deliveries += 1;
					return Promise.reject(emailServiceError(rejection.code, "rejected by the email service"));
				},
			});

			await authentication.handler(
				postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
			);
			outcomes.push({
				deliveries,
				deliveryObservations: observations.filter(({event}) => event.startsWith("authentication_email_")),
			});
		}

		expect(outcomes).toStrictEqual(
			terminalRejections.map(({failure}) => ({
				deliveries: 1,
				deliveryObservations: [
					{
						event: "authentication_email_delivery_failed",
						failure,
						level: "error",
						reason: "request_verification",
						status: null,
					},
				],
			})),
		);
	});

	it("classifies verification requests by account state behind one public response", async () => {
		const password = AUTHENTICATION_PASSWORD;
		const unverifiedEmail = "state-unverified-alice@example.com";
		const verifiedEmail = "state-verified-alice@example.com";
		const unknownEmail = "state-unknown-alice@example.com";
		const {authentication, mailbox, observations} = authenticationWithMailbox();
		for (const email of [unverifiedEmail, verifiedEmail]) {
			await authentication.handler(postAuthentication("sign-up/email", {email, password}));
		}
		await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email: verifiedEmail}),
		);
		await authentication.handler(new Request(emailLink(required(mailbox[0], "verification email"))));
		mailbox.length = 0;
		observations.length = 0;

		const responses = [];
		for (const email of [unverifiedEmail, verifiedEmail, unknownEmail]) {
			const response = await authentication.handler(
				postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
			);
			responses.push({body: await response.json(), status: response.status});
		}

		const acceptedBody = {
			message: "If the request can be completed, check your inbox for next steps.",
			status: true,
		};
		expect({
			messages: mailbox.map(({subject, to}) => ({subject, to})),
			responses,
			serializedContainsAddresses: [unverifiedEmail, verifiedEmail, unknownEmail].some((email) =>
				JSON.stringify(observations).includes(email),
			),
			states: observations
				.filter(({event}) => event === "authentication_verification_state_classified")
				.map(({reason}) => reason),
		}).toStrictEqual({
			messages: [{subject: "Verify your YepNope email", to: unverifiedEmail}],
			responses: [
				{body: acceptedBody, status: 200},
				{body: acceptedBody, status: 200},
				{body: acceptedBody, status: 200},
			],
			serializedContainsAddresses: false,
			states: ["unverified_account", "already_verified", "unknown_account"],
		});
	});

	it("gives a genuinely new account exactly one branded message and one usable token", async () => {
		const {authentication, mailbox} = authenticationWithMailbox();
		const email = "single-token-alice@example.com";
		const password = AUTHENTICATION_PASSWORD;

		// The browser's registration sequence: create the account, then ask for the verification link.
		await authentication.handler(
			postAuthentication("sign-up/email", {callbackURL: "/verify-email", email, password}),
		);
		await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
		);

		expect({
			messages: mailbox.map(({subject, to}) => ({subject, to})),
			tokens: await verificationTokenCount(email),
		}).toStrictEqual({
			messages: [{subject: "Verify your YepNope email", to: email}],
			tokens: 1,
		});

		const verification = await authentication.handler(
			new Request(emailLink(required(mailbox[0], "verification email"))),
		);
		expect({
			location: verification.headers.get("location"),
			status: verification.status,
			tokens: await verificationTokenCount(email),
			verified: await env.DB.prepare("SELECT email_verified FROM user WHERE email = ?").bind(email).first(),
		}).toStrictEqual({
			location: "/verify-email",
			status: 302,
			tokens: 0,
			verified: {email_verified: 1},
		});
	});

	it("records only classified authentication observations", async () => {
		const {authentication, observations} = authenticationWithMailbox();
		const email = "observed-alice@example.com";
		const password = AUTHENTICATION_PASSWORD;
		await authentication.handler(postAuthentication("sign-up/email", {email, password}));
		observations.length = 0;

		await authentication.handler(postAuthentication("sign-up/email", {email, password}));
		await authentication.handler(
			postAuthentication("sign-in/email", {email: "missing-observed-alice@example.com", password}),
		);
		await authentication.handler(postAuthentication("sign-in/email", {email, password: "wrong-password"}));

		expect(observations).toStrictEqual([
			{
				event: "authentication_library_log",
				failure: null,
				level: "info",
				reason: "existing_registration",
				status: null,
			},
			{
				event: "public_authentication_response_normalized",
				failure: null,
				level: "info",
				reason: "register",
				status: 200,
			},
			{
				event: "authentication_library_log",
				failure: null,
				level: "warn",
				reason: "user_not_found",
				status: null,
			},
			{
				event: "public_authentication_response_normalized",
				failure: null,
				level: "warn",
				reason: "sign_in",
				status: 401,
			},
			{
				event: "authentication_library_log",
				failure: null,
				level: "warn",
				reason: "invalid_password",
				status: null,
			},
			{
				event: "public_authentication_response_normalized",
				failure: null,
				level: "warn",
				reason: "sign_in",
				status: 401,
			},
		]);
	});

	it("creates, verifies, restores, signs out, and recovers a verified email account", async () => {
		const {authentication, mailbox} = authenticationWithMailbox();
		const email = "alice@example.com";
		const originalPassword = AUTHENTICATION_PASSWORD;
		const replacementPassword = "example-replacement-password";

		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {
				callbackURL: "/verify-email",
				email,
				password: originalPassword,
			}),
		);
		expect({body: await signUp.json(), status: signUp.status}).toStrictEqual({
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			status: 200,
		});
		const registeredUser = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
			.bind(email)
			.first<{id: string}>();
		if (registeredUser === null) {
			throw new Error("missing registered user");
		}
		expect(mailbox).toStrictEqual([]);

		const verificationRequest = await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
		);
		expect({body: await verificationRequest.json(), status: verificationRequest.status}).toStrictEqual({
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			status: 200,
		});
		const verificationEmail = required(mailbox[0], "verification email");
		const verificationUrl = emailLink(verificationEmail);
		const {html: verificationHtml, ...verificationEnvelope} = verificationEmail;
		expect(verificationEnvelope).toStrictEqual({
			from: {email: "accounts@yepnope.app", name: "YepNope"},
			subject: "Verify your YepNope email",
			text: `Verify your email address to finish creating your YepNope account.\n\nVerify email: ${verificationUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
			to: email,
		});
		expect(emailLinks(verificationHtml)).toStrictEqual([
			{href: escapeHtml(verificationUrl), label: "Verify email"},
			{href: escapeHtml(verificationUrl), label: "Open this secure link"},
		]);
		expect(emailCopy(verificationHtml)).toStrictEqual({
			expiration: "This link expires in one hour.",
			heading: "Verify your YepNope email",
			introduction: "Verify your email address to finish creating your YepNope account.",
			preheader: "Verify your email to finish setting up YepNope.",
			safety: "If you did not request this, you can ignore this email.",
		});
		expect(emailLayout(verificationHtml)).toStrictEqual({
			cardStyle:
				"width:100%;max-width:560px;border-collapse:separate;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:12px;",
			externalAssets: [],
			styleElements: [],
			viewport: "width=device-width, initial-scale=1",
		});
		expect(verificationHtml.replaceAll(escapeHtml(verificationUrl), "{{ACTION_URL}}")).toMatchInlineSnapshot(`
				"<!doctype html>
				<html lang="en">
				<head>
				<meta charset="utf-8">
				<meta name="viewport" content="width=device-width, initial-scale=1">
				<meta name="color-scheme" content="light">
				<title>Verify your YepNope email</title>
				</head>
				<body style="margin:0;padding:0;background-color:#f4f4f5;color:#18181b;">
				<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Verify your email to finish setting up YepNope.</div>
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:#f4f4f5;">
				<tr>
				<td align="center" style="padding:24px 16px;">
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;border-collapse:separate;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
				<tr>
				<td style="padding:28px;font-family:Arial,Helvetica,sans-serif;">
				<p style="margin:0 0 20px;color:#52525b;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">YepNope</p>
				<h1 style="margin:0 0 12px;color:#18181b;font-size:24px;line-height:1.25;font-weight:700;">Verify your YepNope email</h1>
				<p style="margin:0 0 24px;color:#3f3f46;font-size:16px;line-height:1.5;">Verify your email address to finish creating your YepNope account.</p>
				<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
				<tr>
				<td style="border-radius:8px;background-color:#18181b;">
				<a href="{{ACTION_URL}}" style="display:inline-block;padding:12px 20px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:1.25;text-decoration:none;border-radius:8px;">Verify email</a>
				</td>
				</tr>
				</table>
				<p style="margin:24px 0 0;color:#52525b;font-size:14px;line-height:1.5;">This link expires in one hour.</p>
				<p style="margin:12px 0 0;color:#71717a;font-size:12px;line-height:1.5;">Button not working? <a href="{{ACTION_URL}}" style="color:#52525b;text-decoration:underline;">Open this secure link</a>.</p>
				<p style="margin:20px 0 0;padding-top:20px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.5;">If you did not request this, you can ignore this email.</p>
				</td>
				</tr>
				</table>
				</td>
				</tr>
				</table>
				</body>
				</html>"
			`);

		const beforeVerification = await authentication.handler(
			postAuthentication("sign-in/email", {email, password: originalPassword}),
		);
		expect({body: await beforeVerification.json(), status: beforeVerification.status}).toStrictEqual({
			body: {
				code: "AUTHENTICATION_FAILED",
				message: "Sign-in failed. Check your email and password, or recover your account.",
			},
			status: 401,
		});
		const secondVerificationEmail = required(mailbox[1], "second verification email");
		const secondVerificationUrl = emailLink(secondVerificationEmail);
		const {html: secondVerificationHtml, ...secondVerificationEnvelope} = secondVerificationEmail;
		expect(secondVerificationEnvelope).toStrictEqual({
			from: {email: "accounts@yepnope.app", name: "YepNope"},
			subject: "Verify your YepNope email",
			text: `Verify your email address to finish creating your YepNope account.\n\nVerify email: ${secondVerificationUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
			to: email,
		});
		expect(emailLinks(secondVerificationHtml)).toStrictEqual([
			{href: escapeHtml(secondVerificationUrl), label: "Verify email"},
			{href: escapeHtml(secondVerificationUrl), label: "Open this secure link"},
		]);

		const verification = await authentication.handler(
			new Request(emailLink(required(mailbox[0], "verification email"))),
		);
		const sessionCookie = cookieFrom(verification);
		expect({
			cookie: verification.headers.get("set-cookie"),
			location: verification.headers.get("location"),
			status: verification.status,
		}).toStrictEqual({
			cookie: expect.stringMatching(
				/^__Secure-better-auth\.session_token=.+; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
			),
			location: "/verify-email",
			status: 302,
		});
		expect(
			await env.DB.prepare("SELECT email_verified FROM user WHERE email = ?").bind(email).first(),
		).toStrictEqual({
			email_verified: 1,
		});
		const replay = await authentication.handler(new Request(emailLink(required(mailbox[0], "verification email"))));
		expect({
			cookie: replay.headers.get("set-cookie"),
			location: replay.headers.get("location"),
			status: replay.status,
		}).toStrictEqual({
			cookie: null,
			location: "/verify-email?error=INVALID_TOKEN",
			status: 302,
		});

		const {authentication: restoredAuthentication, mailbox: restoredMailbox} = authenticationWithMailbox();
		const restored = await restoredAuthentication.handler(
			new Request(`${API_ORIGIN}/api/auth/get-session`, {headers: {Cookie: sessionCookie}}),
		);
		const restoredBody = await restored.json<{
			session: {userId: string};
			user: {email: string; emailVerified: boolean; id: string};
		}>();
		expect({
			status: restored.status,
			user: {
				email: restoredBody.user.email,
				emailVerified: restoredBody.user.emailVerified,
				id: restoredBody.user.id,
				sessionUserId: restoredBody.session.userId,
			},
		}).toStrictEqual({
			status: 200,
			user: {
				email,
				emailVerified: true,
				id: registeredUser.id,
				sessionUserId: registeredUser.id,
			},
		});
		expect(
			await env.DB.prepare("SELECT count(*) AS sessions FROM session WHERE user_id = ?")
				.bind(registeredUser.id)
				.first(),
		).toStrictEqual({sessions: 1});
		const replayedSession = await restoredAuthentication.handler(new Request(`${API_ORIGIN}/api/auth/get-session`));
		expect({body: await replayedSession.json(), status: replayedSession.status}).toStrictEqual({
			body: null,
			status: 200,
		});

		const signOut = await restoredAuthentication.handler(postAuthentication("sign-out", {}, sessionCookie));
		expect({body: await signOut.json(), status: signOut.status}).toStrictEqual({
			body: {success: true},
			status: 200,
		});
		const signedOutSession = await restoredAuthentication.handler(
			new Request(`${API_ORIGIN}/api/auth/get-session`, {headers: {Cookie: sessionCookie}}),
		);
		expect({body: await signedOutSession.json(), status: signedOutSession.status}).toStrictEqual({
			body: null,
			status: 200,
		});
		const firstOldSession = cookieFrom(
			await restoredAuthentication.handler(
				postAuthentication("sign-in/email", {email, password: originalPassword}),
			),
		);
		const secondOldSession = cookieFrom(
			await restoredAuthentication.handler(
				postAuthentication("sign-in/email", {email, password: originalPassword}),
			),
		);
		expect(
			await env.DB.prepare("SELECT count(*) AS sessions FROM session WHERE user_id = ?")
				.bind(registeredUser.id)
				.first(),
		).toStrictEqual({sessions: 2});

		const resetRequest = await restoredAuthentication.handler(
			postAuthentication("request-password-reset", {email, redirectTo: "/reset-password"}),
		);
		expect({body: await resetRequest.json(), status: resetRequest.status}).toStrictEqual({
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			status: 200,
		});
		const resetEmail = required(restoredMailbox[0], "password reset email");
		const resetUrl = emailLink(resetEmail);
		const {html: resetHtml, ...resetEnvelope} = resetEmail;
		expect(resetEnvelope).toStrictEqual({
			from: {email: "accounts@yepnope.app", name: "YepNope"},
			subject: "Reset your YepNope password",
			text: `Choose a new password for your YepNope account.\n\nReset password: ${resetUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
			to: email,
		});
		expect(emailLinks(resetHtml)).toStrictEqual([
			{href: escapeHtml(resetUrl), label: "Reset password"},
			{href: escapeHtml(resetUrl), label: "Open this secure link"},
		]);
		expect(emailCopy(resetHtml)).toStrictEqual({
			expiration: "This link expires in one hour.",
			heading: "Reset your YepNope password",
			introduction: "Choose a new password for your YepNope account.",
			preheader: "Reset your YepNope password securely.",
			safety: "If you did not request this, you can ignore this email.",
		});
		const resetTokenUrl = new URL(resetUrl);
		const resetToken = required(resetTokenUrl.pathname.split("/").at(-1), "password reset token");
		await env.DB.prepare(
			"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(
				"expired-password-reset",
				"reset-password:expired-reset-token",
				registeredUser.id,
				946_688_400_000,
				946_684_800_000,
				946_684_800_000,
			)
			.run();
		const expiredReset = await restoredAuthentication.handler(
			postAuthentication("reset-password", {
				newPassword: "expired-token-replacement-password",
				token: "expired-reset-token",
			}),
		);
		expect({body: await expiredReset.json(), status: expiredReset.status}).toStrictEqual({
			body: {code: "INVALID_TOKEN", message: "Invalid token"},
			status: 400,
		});
		const reset = await restoredAuthentication.handler(
			postAuthentication("reset-password", {newPassword: replacementPassword, token: resetToken}),
		);
		expect({body: await reset.json(), status: reset.status}).toStrictEqual({body: {status: true}, status: 200});
		const replayedReset = await restoredAuthentication.handler(
			postAuthentication("reset-password", {newPassword: "replayed-token-password", token: resetToken}),
		);
		const oldSessionStates = await Promise.all(
			[firstOldSession, secondOldSession].map(async (cookie) => {
				const response = await restoredAuthentication.handler(
					new Request(`${API_ORIGIN}/api/auth/get-session`, {headers: {Cookie: cookie}}),
				);
				return {body: await response.json(), status: response.status};
			}),
		);
		expect({
			oldSessionStates,
			replayedReset: {body: await replayedReset.json(), status: replayedReset.status},
			sessionCount: await env.DB.prepare("SELECT count(*) AS sessions FROM session WHERE user_id = ?")
				.bind(registeredUser.id)
				.first(),
		}).toStrictEqual({
			oldSessionStates: [
				{body: null, status: 200},
				{body: null, status: 200},
			],
			replayedReset: {body: {code: "INVALID_TOKEN", message: "Invalid token"}, status: 400},
			sessionCount: {sessions: 0},
		});

		const recovered = await restoredAuthentication.handler(
			postAuthentication("sign-in/email", {email, password: replacementPassword}),
		);
		const recoveredBody = await recovered
			.clone()
			.json<{user: {email: string; emailVerified: boolean; id: string}}>();
		expect({status: recovered.status, user: recoveredBody.user}).toStrictEqual({
			status: 200,
			user: {
				createdAt: expect.any(String),
				email,
				emailVerified: true,
				id: registeredUser.id,
				image: null,
				updatedAt: expect.any(String),
			},
		});
		expect(cookieFrom(recovered)).toMatch(/^__Secure-better-auth\.session_token=.+$/);
		expect(
			await env.DB.prepare("SELECT count(*) AS sessions FROM session WHERE user_id = ?")
				.bind(registeredUser.id)
				.first(),
		).toStrictEqual({sessions: 1});
	});

	it("rejects an expired email verification link without creating a session", async () => {
		const {authentication} = authenticationWithMailbox();
		const email = "expired-alice@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {email, password: AUTHENTICATION_PASSWORD}),
		);
		expect(signUp.status).toBe(200);
		const expiredToken = await new SignJWT({email})
			.setProtectedHeader({alg: "HS256"})
			.setIssuedAt(946_684_800)
			.setExpirationTime(946_688_400)
			.sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET));
		await env.DB.prepare(
			"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(
				"expired-email-verification",
				`yepnope-email-verification:${await hashToken(expiredToken)}`,
				email,
				946_688_400_000,
				946_684_800_000,
				946_684_800_000,
			)
			.run();

		const verification = await authentication.handler(
			new Request(
				`${API_ORIGIN}/api/auth/verify-email?token=${expiredToken}&callbackURL=${encodeURIComponent("/verify-email")}`,
			),
		);
		expect({
			cookie: verification.headers.get("set-cookie"),
			location: verification.headers.get("location"),
			status: verification.status,
			user: await env.DB.prepare("SELECT email_verified FROM user WHERE email = ?").bind(email).first(),
		}).toStrictEqual({
			cookie: null,
			location: "/verify-email?error=TOKEN_EXPIRED",
			status: 302,
			user: {email_verified: 0},
		});
	});

	it("mounts Better Auth under the Worker authentication route", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/auth/get-session`);
		expect({body: await response.json(), status: response.status}).toStrictEqual({body: null, status: 200});
	});
});
