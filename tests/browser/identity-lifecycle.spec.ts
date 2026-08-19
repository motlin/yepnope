import {
	expect,
	test,
	type APIRequestContext,
	type BrowserContext,
	type Page,
	type WebSocketRoute,
} from "playwright/test";

const email = "alice-browser-test@example.com";
const originalPassword = "browser-test-original-password";
const replacementPassword = "browser-test-replacement-password";
const verificationSubject = "Verify your YepNope email";
const resetSubject = "Reset your YepNope password";

interface MailboxResponse {
	url: string;
}

interface SessionResponse {
	user: {id: string};
}

async function signIn(page: Page, password: string): Promise<void> {
	await page.goto("/sign-in");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", {name: "Sign in", exact: true}).click();
	await expect(page).toHaveURL(/\/settings$/);
}

async function mailboxLink(request: APIRequestContext, subject: string, recipient = email): Promise<string> {
	await expect
		.poll(async () => {
			const response = await request.get("/api/__e2e__/mailbox", {params: {email: recipient, subject}});
			return response.status();
		})
		.toBe(200);
	const response = await request.get("/api/__e2e__/mailbox", {params: {email: recipient, subject}});
	return ((await response.json()) as MailboxResponse).url;
}

async function sessionUserId(page: Page): Promise<string> {
	const response = await page.request.get("/api/auth/get-session");
	expect(response.status()).toBe(200);
	return ((await response.json()) as SessionResponse).user.id;
}

async function answerCurrentCard(page: Page, buttonName: string, nextHeading: string): Promise<void> {
	await page.getByRole("button", {name: buttonName}).click();
	await expect(page.getByRole("heading", {name: nextHeading})).toBeVisible();
}

async function closeContexts(contexts: BrowserContext[]): Promise<void> {
	await Promise.all(contexts.map(async (context) => context.close()));
}

test("identity registration, recovery, connected clients, answers, revocation, and deletion", async ({
	browser,
	request,
}) => {
	const contexts: BrowserContext[] = [];
	try {
		const firstContext = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(firstContext);
		const firstPage = await firstContext.newPage();
		let transientFailuresRemaining = 2;
		let transientRecoveryConnections = 0;
		let firstHealthyConnectionAttempt: number | null = null;
		await firstPage.routeWebSocket("**/api/v1/current-deck/stream", async (socket: WebSocketRoute) => {
			transientRecoveryConnections += 1;
			if (transientFailuresRemaining > 0) {
				transientFailuresRemaining -= 1;
				await socket.close({code: 1012, reason: "browser test transient failure"});
				return;
			}
			firstHealthyConnectionAttempt ??= transientRecoveryConnections;
			socket.connectToServer();
		});

		expect(await (await request.get("/api/__e2e__/counts")).json()).toStrictEqual({
			authentication_url: "https://127.0.0.1:4173",
			machine_tokens: 0,
			pairing_codes: 0,
			users: 0,
		});
		await firstPage.goto("/");
		await expect(firstPage.getByRole("button", {name: "Sign in"})).toBeVisible();
		await expect(firstPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		await expect(
			firstPage.getByText("Your question queue is empty. New questions will appear here when they arrive."),
		).toBeVisible();
		await expect(firstPage.locator(".card, .actions")).toHaveCount(0);
		expect(await (await request.get("/api/__e2e__/counts")).json()).toStrictEqual({
			authentication_url: "https://127.0.0.1:4173",
			machine_tokens: 0,
			pairing_codes: 0,
			users: 0,
		});

		await firstPage.getByRole("button", {name: "Sign in"}).click();
		await expect(firstPage).toHaveURL(/\/sign-in$/);
		await expect(firstPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await firstPage.getByRole("button", {name: "Create an account"}).click();
		await expect(firstPage).toHaveURL(/\/register$/);
		await expect(firstPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await firstPage.getByRole("textbox", {name: "Email"}).fill(email);
		await firstPage.getByLabel("Password").fill(originalPassword);
		await firstPage.getByRole("button", {name: "Create account"}).click();
		await expect(firstPage.getByRole("heading", {name: "Check your email"})).toBeVisible();

		const verificationContext = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(verificationContext);
		const verificationPage = await verificationContext.newPage();
		await verificationPage.goto(await mailboxLink(request, verificationSubject));
		await expect(verificationPage).toHaveURL(/\/$/);
		await expect(verificationPage.getByRole("button", {name: "Connect an MCP client"})).toBeVisible();
		await verificationPage.getByRole("button", {name: "Settings"}).click();
		await expect(verificationPage.getByText(email)).toBeVisible();
		const verifiedUserId = await sessionUserId(verificationPage);
		await verificationContext.close();
		contexts.splice(contexts.indexOf(verificationContext), 1);

		await firstPage.goto("/sign-in");
		await firstPage.getByRole("textbox", {name: "Email"}).fill(email);
		await firstPage.getByLabel("Password").fill(originalPassword);
		await firstPage.getByRole("button", {name: "Sign in", exact: true}).click();
		await expect(firstPage.getByText(email)).toBeVisible();
		await expect.poll(() => firstHealthyConnectionAttempt).toBe(3);
		await expect(firstPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		const userId = await sessionUserId(firstPage);
		expect(userId).toBe(verifiedUserId);

		const secondContext = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(secondContext);
		const secondPage = await secondContext.newPage();
		await signIn(secondPage, originalPassword);
		await expect(secondPage.getByText("No connected MCP clients.")).toBeVisible();
		await expect(secondPage.getByRole("heading", {name: "Signed-in browsers"})).toBeVisible();
		await expect(secondPage.getByRole("listitem").filter({hasText: "This browser"})).toHaveCount(1);
		const authorization = await request.post("/api/__e2e__/authorize-mcp-client", {data: {user_id: userId}});
		expect({body: await authorization.json(), status: authorization.status()}).toStrictEqual({
			body: {status: "authorized"},
			status: 200,
		});
		await expect(firstPage.getByText("Browser test MCP client")).toBeVisible();
		await secondPage.reload();
		await expect(secondPage.getByText("Browser test MCP client")).toBeVisible();
		await firstPage.getByRole("button", {name: "Back to the deck"}).click();
		await expect(firstPage.getByRole("button", {name: "1 MCP client authorized"})).toBeVisible();
		await expect(firstPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		await expect(firstPage.getByRole("button", {name: "AFK off"})).toHaveAttribute("aria-pressed", "false");

		await firstPage.getByRole("button", {name: "AFK off"}).click();
		await expect(firstPage.getByRole("button", {name: "AFK on"})).toHaveAttribute("aria-pressed", "true");
		await expect
			.poll(async () => {
				const response = await firstPage.request.get("/api/v1/afk");
				return {body: await response.json(), status: response.status()};
			})
			.toStrictEqual({body: {afk: true}, status: 200});
		const created = await firstPage.request.post("/api/v1/questions", {
			data: {
				project: "Browser test",
				questions: [
					{title: "Approve the browser test change?", body: "Exercise the yep outcome."},
					{title: "Reject the browser test risk?", body: "Exercise the nope outcome."},
					{title: "Defer the optional browser test?", body: "Exercise the skip outcome."},
				],
			},
		});
		expect(created.status()).toBe(201);
		await expect(firstPage.getByRole("heading", {name: "Approve the browser test change?"})).toBeVisible();
		await answerCurrentCard(firstPage, "Yep →", "Reject the browser test risk?");
		await answerCurrentCard(firstPage, "← Nope", "Defer the optional browser test?");
		await answerCurrentCard(firstPage, "↓ Skip", "All caught up");

		const summary = await firstPage.request.get("/api/v1/activity-summary");
		expect({body: await summary.json(), status: summary.status()}).toStrictEqual({
			body: {
				activity_summary: {
					expired: 0,
					nope: 1,
					outstanding: 0,
					retracted: 0,
					skip: 1,
					total_questions: 3,
					yep: 1,
				},
			},
			status: 200,
		});

		const failureContext = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(failureContext);
		const failurePage = await failureContext.newPage();
		let boundedFailureConnections = 0;
		await failurePage.routeWebSocket("**/api/v1/current-deck/stream", async (socket: WebSocketRoute) => {
			boundedFailureConnections += 1;
			await socket.close({code: 1012, reason: "browser test persistent failure"});
		});
		await signIn(failurePage, originalPassword);
		await expect.poll(() => boundedFailureConnections, {timeout: 15_000}).toBe(5);
		await failurePage.waitForTimeout(3_000);
		expect(boundedFailureConnections).toBe(5);
		await failureContext.close();
		contexts.splice(contexts.indexOf(failureContext), 1);

		await expect(secondPage.getByText(email)).toBeVisible();
		await expect(secondPage.getByText("Browser test MCP client")).toBeVisible();
		await secondPage.getByRole("button", {name: "Sign out"}).click();
		await expect(secondPage).toHaveURL(/\/$/);

		await secondPage.getByRole("button", {name: "Sign in"}).click();
		await expect(secondPage).toHaveURL(/\/sign-in$/);
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await secondPage.getByRole("button", {name: "Forgot password?"}).click();
		await expect(secondPage).toHaveURL(/\/forgot-password$/);
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await secondPage.getByRole("textbox", {name: "Email"}).fill(email);
		await secondPage.getByRole("button", {name: "Send recovery email"}).click();
		await expect(secondPage.getByRole("status")).toHaveText(
			"If recovery is available for that address, check its inbox for next steps.",
		);
		const resetLink = await mailboxLink(request, resetSubject);
		await secondPage.goto(resetLink);
		await expect(secondPage.getByRole("heading", {name: "Choose a new password"})).toBeVisible();
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		let resetRequests = 0;
		await secondPage.route("**/api/auth/reset-password", async (route) => {
			resetRequests += 1;
			await route.continue();
		});
		await secondPage.route(
			"**/api/auth/sign-in/email",
			async (route) =>
				route.fulfill({
					body: JSON.stringify({message: "Sign-in temporarily unavailable"}),
					contentType: "application/json",
					status: 503,
				}),
			{times: 1},
		);
		await secondPage.getByRole("textbox", {name: "Email"}).fill(email);
		await secondPage.getByLabel("New password").fill(replacementPassword);
		await secondPage.getByRole("button", {name: "Save new password"}).click();
		await expect(secondPage.getByRole("status")).toHaveText("Your password has been changed.");
		await expect(secondPage.getByRole("alert")).toHaveText("Sign-in temporarily unavailable");
		await expect(secondPage).toHaveURL(/\/reset-password$/);
		const invalidatedSession = await firstPage.request.get("/api/auth/get-session");
		expect({
			body: await invalidatedSession.json(),
			resetRequests,
			status: invalidatedSession.status(),
		}).toStrictEqual({body: null, resetRequests: 1, status: 200});
		await secondPage.getByRole("button", {name: "Try signing in again"}).click();
		await expect(secondPage.getByText("Browser test MCP client")).toBeVisible();
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		expect(resetRequests).toBe(1);

		await secondPage.goto(resetLink);
		await expect(secondPage.getByRole("alert")).toHaveText("This recovery link is invalid or expired.");
		expect({
			path: new URL(secondPage.url()).pathname,
			resetRequests,
			resetTokenError: new URL(secondPage.url()).searchParams.get("error"),
		}).toStrictEqual({path: "/reset-password", resetRequests: 1, resetTokenError: "INVALID_TOKEN"});
		await secondPage.goto("/settings");
		await expect(secondPage.getByText("Browser test MCP client")).toBeVisible();

		const mcpClientRow = secondPage.getByRole("listitem").filter({hasText: "Browser test MCP client"});
		await mcpClientRow.getByRole("button", {name: "Revoke"}).click();
		await expect(mcpClientRow).toContainText("revoked");
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		const accountAfk = await secondPage.request.get("/api/v1/afk");
		expect({body: await accountAfk.json(), status: accountAfk.status()}).toStrictEqual({
			body: {afk: false},
			status: 200,
		});

		const deletion = await secondPage.evaluate(async (password) => {
			const response = await fetch("/api/auth/delete-user", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({password}),
			});
			return {body: (await response.json()) as unknown, status: response.status};
		}, replacementPassword);
		expect(deletion).toStrictEqual({body: {message: "User deleted", success: true}, status: 200});
		await secondPage.reload();
		await expect(secondPage.getByRole("button", {name: "Sign in"})).toHaveCount(3);
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);

		const deletedState = await request.post("/api/__e2e__/deleted-account", {data: {user_id: userId}});
		expect({body: await deletedState.json(), status: deletedState.status()}).toStrictEqual({
			body: {cleanup_completed: 1, identity_deleted: 1, machine_tokens: 0, oauth_clients: 0, users: 0},
			status: 200,
		});
	} finally {
		await closeContexts(contexts);
	}
});

test("public authentication contracts do not reveal account state", async ({page, request}) => {
	const password = "browser-contract-password";
	const unverifiedEmail = "unverified-browser-contract@example.com";
	const verifiedEmail = "verified-browser-contract@example.com";
	const missingEmail = "missing-browser-contract@example.com";
	const acceptedBody = {
		message: "If the request can be completed, check your inbox for next steps.",
		status: true,
	};
	const acceptedContract = {body: acceptedBody, status: 200};
	const signInFailureContract = {
		body: {
			code: "AUTHENTICATION_FAILED",
			message: "Sign-in failed. Check your email and password, or recover your account.",
		},
		status: 401,
	};

	async function post(path: string, data: Record<string, string>) {
		const startedAt = performance.now();
		const response = await request.post(`/api/auth/${path}`, {data});
		return {
			contract: {body: await response.json(), status: response.status()},
			elapsedMilliseconds: performance.now() - startedAt,
		};
	}

	for (const accountEmail of [unverifiedEmail, verifiedEmail]) {
		await post("sign-up/email", {callbackURL: "/verify-email", email: accountEmail, password});
	}
	await post("send-verification-email", {callbackURL: "/verify-email", email: verifiedEmail});
	await page.goto(await mailboxLink(request, verificationSubject, verifiedEmail));
	await expect(page).toHaveURL(/\/$/);
	await page.context().clearCookies();

	const registrations = [];
	for (const accountEmail of [missingEmail, unverifiedEmail, verifiedEmail]) {
		registrations.push(await post("sign-up/email", {callbackURL: "/verify-email", email: accountEmail, password}));
	}
	const signIns = [];
	for (const accountEmail of ["unknown-browser-contract@example.com", unverifiedEmail, verifiedEmail]) {
		signIns.push(await post("sign-in/email", {email: accountEmail, password: "wrong-password"}));
	}
	const verificationRequests = [];
	for (const accountEmail of ["unknown-browser-contract@example.com", unverifiedEmail, verifiedEmail]) {
		verificationRequests.push(
			await post("send-verification-email", {callbackURL: "/verify-email", email: accountEmail}),
		);
	}
	const recoveryRequests = [];
	for (const accountEmail of ["unknown-browser-contract@example.com", unverifiedEmail, verifiedEmail]) {
		recoveryRequests.push(
			await post("request-password-reset", {email: accountEmail, redirectTo: "/reset-password"}),
		);
	}

	expect({
		recovery: recoveryRequests.map(({contract}) => contract),
		registration: registrations.map(({contract}) => contract),
		signIn: signIns.map(({contract}) => contract),
		verification: verificationRequests.map(({contract}) => contract),
	}).toStrictEqual({
		recovery: [acceptedContract, acceptedContract, acceptedContract],
		registration: [acceptedContract, acceptedContract, acceptedContract],
		signIn: [signInFailureContract, signInFailureContract, signInFailureContract],
		verification: [acceptedContract, acceptedContract, acceptedContract],
	});
	const elapsedMilliseconds = [...registrations, ...signIns, ...verificationRequests, ...recoveryRequests].map(
		(result) => result.elapsedMilliseconds,
	);
	expect(Math.min(...elapsedMilliseconds)).toBeGreaterThanOrEqual(450);

	const signInCopy = [];
	for (const accountEmail of ["unknown-ui-browser-contract@example.com", verifiedEmail]) {
		await page.goto("/sign-in");
		await page.getByRole("textbox", {name: "Email"}).fill(accountEmail);
		await page.getByLabel("Password").fill("wrong-password");
		await page.getByRole("button", {name: "Sign in", exact: true}).click();
		signInCopy.push(await page.getByRole("alert").textContent());
	}

	const registrationCopy = [];
	for (const accountEmail of ["new-ui-browser-contract@example.com", unverifiedEmail, verifiedEmail]) {
		await page.goto("/register");
		await page.getByRole("textbox", {name: "Email"}).fill(accountEmail);
		await page.getByLabel("Password").fill(password);
		await page.getByRole("button", {name: "Create account"}).click();
		registrationCopy.push(await page.getByRole("status").textContent());
	}

	const verificationCopy = [];
	for (const accountEmail of ["unknown-ui-browser-contract@example.com", unverifiedEmail, verifiedEmail]) {
		await page.goto("/verify-email");
		await page.getByRole("textbox", {name: "Email"}).fill(accountEmail);
		await page.getByRole("button", {name: "Resend verification email"}).click();
		verificationCopy.push(await page.getByRole("status").textContent());
	}

	const recoveryCopy = [];
	for (const accountEmail of ["unknown-ui-browser-contract@example.com", unverifiedEmail, verifiedEmail]) {
		await page.goto("/forgot-password");
		await page.getByRole("textbox", {name: "Email"}).fill(accountEmail);
		await page.getByRole("button", {name: "Send recovery email"}).click();
		recoveryCopy.push(await page.getByRole("status").textContent());
	}

	expect({recoveryCopy, registrationCopy, signInCopy, verificationCopy}).toStrictEqual({
		recoveryCopy: [
			"If recovery is available for that address, check its inbox for next steps.",
			"If recovery is available for that address, check its inbox for next steps.",
			"If recovery is available for that address, check its inbox for next steps.",
		],
		registrationCopy: [
			"If verification is available for that address, check its inbox for next steps.",
			"If verification is available for that address, check its inbox for next steps.",
			"If verification is available for that address, check its inbox for next steps.",
		],
		signInCopy: [
			"Sign-in failed. Check your email and password, or recover your account.",
			"Sign-in failed. Check your email and password, or recover your account.",
		],
		verificationCopy: [
			"If verification is available for that address, check its inbox for next steps.",
			"If verification is available for that address, check its inbox for next steps.",
			"If verification is available for that address, check its inbox for next steps.",
		],
	});
});
