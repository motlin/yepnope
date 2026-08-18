import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {createAuthentication} from "../auth";
import {API_ORIGIN, cookieFrom, emailLink, required, worker} from "./helpers";

interface DeliveredEmail {
	from: string | EmailAddress;
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
					subject: message.subject,
					text: required(message.text, "email text"),
					to: required(message.to, "email recipient"),
				}),
			);
		},
	});
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
					name: "Alice",
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

	it("links only provider identities that resolve to the same verified email account", () => {
		const authentication = createMailboxAuthentication([]);
		expect(authentication.options.account.accountLinking).toStrictEqual({
			allowDifferentEmails: false,
			disableImplicitLinking: false,
			enabled: true,
		});
	});

	it("creates, verifies, restores, signs out, and recovers a verified email account", async () => {
		const mailbox: DeliveredEmail[] = [];
		const authentication = createMailboxAuthentication(mailbox);
		const email = "alice@example.com";
		const originalPassword = "correct-horse-battery-staple";
		const replacementPassword = "example-replacement-password";

		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {
				callbackURL: "/",
				email,
				name: "Alice",
				password: originalPassword,
			}),
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
					name: "Alice",
					updatedAt: expect.any(String),
				},
			},
			status: 200,
		});
		expect(mailbox).toStrictEqual([]);

		const verificationRequest = await authentication.handler(
			postAuthentication("send-verification-email", {callbackURL: "/", email}),
		);
		expect({body: await verificationRequest.json(), status: verificationRequest.status}).toStrictEqual({
			body: {status: true},
			status: 200,
		});
		expect(mailbox).toStrictEqual([
			{
				from: {email: "accounts@yepnope.app", name: "YepNope"},
				subject: "Verify your YepNope email",
				text: expect.stringMatching(/^Verify your email address/),
				to: email,
			},
		]);

		const beforeVerification = await authentication.handler(
			postAuthentication("sign-in/email", {email, password: originalPassword}),
		);
		expect({body: await beforeVerification.json(), status: beforeVerification.status}).toStrictEqual({
			body: {code: "EMAIL_NOT_VERIFIED", message: "Email not verified"},
			status: 403,
		});
		expect(mailbox).toStrictEqual([
			{
				from: {email: "accounts@yepnope.app", name: "YepNope"},
				subject: "Verify your YepNope email",
				text: expect.stringMatching(/^Verify your email address/),
				to: email,
			},
			{
				from: {email: "accounts@yepnope.app", name: "YepNope"},
				subject: "Verify your YepNope email",
				text: expect.stringMatching(/^Verify your email address/),
				to: email,
			},
		]);

		const verification = await authentication.handler(
			new Request(emailLink(required(mailbox[0], "verification email"))),
		);
		expect({location: verification.headers.get("location"), status: verification.status}).toStrictEqual({
			location: "/",
			status: 302,
		});

		const signIn = await authentication.handler(
			postAuthentication("sign-in/email", {email, password: originalPassword}),
		);
		const signedInBody = await signIn.clone().json<{user: {id: string}}>();
		const sessionCookie = cookieFrom(signIn);
		expect({cookie: signIn.headers.get("set-cookie"), status: signIn.status}).toStrictEqual({
			cookie: expect.stringMatching(
				/^__Secure-better-auth\.session_token=.+; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
			),
			status: 200,
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
			user: {email, emailVerified: true, id: signedInBody.user.id, sessionUserId: signedInBody.user.id},
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
		expect(resetEmail).toStrictEqual({
			from: {email: "accounts@yepnope.app", name: "YepNope"},
			subject: "Reset your YepNope password",
			text: expect.stringMatching(/^Use this link to choose a new YepNope password/),
			to: email,
		});
		const resetUrl = new URL(emailLink(resetEmail));
		const resetToken = required(resetUrl.pathname.split("/").at(-1), "password reset token");
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
				id: signedInBody.user.id,
				image: null,
				name: "Alice",
				updatedAt: expect.any(String),
			},
		});
		expect(cookieFrom(recovered)).toMatch(/^__Secure-better-auth\.session_token=.+$/);
	});

	it("mounts Better Auth under the Worker authentication route", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/auth/get-session`);
		expect({body: await response.json(), status: response.status}).toStrictEqual({body: null, status: 200});
	});
});
