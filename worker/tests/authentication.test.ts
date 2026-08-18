import {env} from "cloudflare:workers";
import {SignJWT} from "jose";
import {describe, expect, it} from "vitest";
import {createAuthentication, hashToken} from "../auth";
import {API_ORIGIN, cookieFrom, emailLink, required, worker} from "./helpers";

interface DeliveredEmail {
	from: string | EmailAddress;
	html: string;
	subject: string;
	text: string;
	to: string | EmailAddress | (string | EmailAddress)[];
}

function createMailboxAuthentication(mailbox: DeliveredEmail[]) {
	return createAuthentication(env, {
		runInBackground: undefined,
		sendEmail: async (message) => {
			await Promise.resolve(
				mailbox.push({
					from: message.from,
					html: required(message.html, "email HTML"),
					subject: message.subject,
					text: required(message.text, "email text"),
					to: required(message.to, "email recipient"),
				}),
			);
		},
	});
}

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

function postAuthentication(path: string, body: Record<string, string>, cookie?: string): Request {
	const headers = new Headers({"Content-Type": "application/json", Origin: API_ORIGIN});
	if (cookie !== undefined) {
		headers.set("Cookie", cookie);
	}
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {method: "POST", headers, body: JSON.stringify(body)});
}

describe("Better Auth account recovery", () => {
	it("deduplicates concurrent account onboarding without minting browser credentials", async () => {
		const authentication = createMailboxAuthentication([]);
		const requests = Array.from({length: 10}, async () =>
			authentication.handler(
				postAuthentication("sign-up/email", {
					callbackURL: "/",
					email: "concurrent-alice@example.com",
					password: "correct-horse-battery-staple",
				}),
			),
		);

		await Promise.all(requests);
		expect(
			await env.DB.prepare(
				"SELECT (SELECT count(*) FROM user) AS users, " +
					"(SELECT count(*) FROM account) AS accounts, " +
					"(SELECT count(*) FROM identity_lifecycles) AS identities, " +
					"(SELECT count(*) FROM machine_tokens) AS machine_tokens",
			).first(),
		).toStrictEqual({accounts: 1, identities: 1, machine_tokens: 0, users: 1});
	});

	it("registers with only email and password and never stores or returns a display name", async () => {
		const authentication = createMailboxAuthentication([]);
		const email = "alice@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {email, password: "correct-horse-battery-staple"}),
		);

		expect({body: await signUp.json(), status: signUp.status}).toStrictEqual({
			body: {
				token: null,
				user: {
					createdAt: expect.any(String),
					email,
					emailVerified: false,
					id: expect.any(String),
					image: null,
					updatedAt: expect.any(String),
				},
			},
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
				password: "correct-horse-battery-staple",
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

	it("links only provider identities that resolve to the same verified email account", () => {
		const authentication = createMailboxAuthentication([]);
		expect(authentication.options.account.accountLinking).toStrictEqual({
			allowDifferentEmails: false,
			disableImplicitLinking: false,
			enabled: true,
		});
	});

	it("keeps verification resend responses generic for unknown email addresses", async () => {
		const mailbox: DeliveredEmail[] = [];
		const authentication = createMailboxAuthentication(mailbox);
		const email = "generic-alice@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {email, password: "correct-horse-battery-staple"}),
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
			{body: {status: true}, status: 200},
			{body: {status: true}, status: 200},
		]);
		expect(mailbox.map(({subject, to}) => ({subject, to}))).toStrictEqual([
			{subject: "Verify your YepNope email", to: email},
		]);
	});

	it("creates, verifies, restores, signs out, and recovers a verified email account", async () => {
		const mailbox: DeliveredEmail[] = [];
		const authentication = createMailboxAuthentication(mailbox);
		const email = "alice@example.com";
		const originalPassword = "correct-horse-battery-staple";
		const replacementPassword = "example-replacement-password";

		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {
				callbackURL: "/verify-email",
				email,
				password: originalPassword,
			}),
		);
		const signUpBody = await signUp.json<{user: {id: string}}>();
		expect({body: signUpBody, status: signUp.status}).toStrictEqual({
			body: {
				token: null,
				user: {
					createdAt: expect.any(String),
					email,
					emailVerified: false,
					id: expect.any(String),
					image: null,
					updatedAt: expect.any(String),
				},
			},
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
			body: {status: true},
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
			body: {code: "EMAIL_NOT_VERIFIED", message: "Email not verified"},
			status: 403,
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

		const restoredAuthentication = createMailboxAuthentication(mailbox);
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

		const resetRequest = await restoredAuthentication.handler(
			postAuthentication("request-password-reset", {email, redirectTo: "/reset-password"}),
		);
		expect({body: await resetRequest.json(), status: resetRequest.status}).toStrictEqual({
			body: {message: "If this email exists in our system, check your email for the reset link", status: true},
			status: 200,
		});
		const resetEmail = required(mailbox[2], "password reset email");
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
		const reset = await restoredAuthentication.handler(
			postAuthentication("reset-password", {newPassword: replacementPassword, token: resetToken}),
		);
		expect({body: await reset.json(), status: reset.status}).toStrictEqual({body: {status: true}, status: 200});

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
	});

	it("rejects an expired email verification link without creating a session", async () => {
		const authentication = createMailboxAuthentication([]);
		const email = "expired-alice@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {email, password: "correct-horse-battery-staple"}),
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
