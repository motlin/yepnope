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

interface PairingResponse {
	token: string;
}

async function signIn(page: Page, password: string): Promise<void> {
	await page.goto("/sign-in");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", {name: "Sign in", exact: true}).click();
	await expect(page).toHaveURL(/\/settings$/);
}

async function mailboxLink(request: APIRequestContext, subject: string): Promise<string> {
	await expect
		.poll(async () => {
			const response = await request.get("/api/__e2e__/mailbox", {params: {email, subject}});
			return response.status();
		})
		.toBe(200);
	const response = await request.get("/api/__e2e__/mailbox", {params: {email, subject}});
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

test("identity registration, recovery, pairing, answers, revocation, and deletion", async ({browser, request}) => {
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
		await expect(firstPage.getByRole("button", {name: "Sign in to pair"})).toBeVisible();
		await expect(firstPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		await expect(firstPage.locator(".card, .actions")).toHaveCount(0);
		expect(await (await request.get("/api/__e2e__/counts")).json()).toStrictEqual({
			authentication_url: "https://127.0.0.1:4173",
			machine_tokens: 0,
			pairing_codes: 0,
			users: 0,
		});

		await firstPage.getByRole("button", {name: "Sign in to pair"}).click();
		await expect(firstPage).toHaveURL(/\/sign-in$/);
		await expect(firstPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await firstPage.getByRole("button", {name: "Create an account"}).click();
		await expect(firstPage).toHaveURL(/\/register$/);
		await expect(firstPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await firstPage.getByRole("textbox", {name: "Email"}).fill(email);
		await firstPage.getByLabel("Password").fill(originalPassword);
		await firstPage.getByRole("button", {name: "Create account"}).click();
		await expect(firstPage.getByRole("heading", {name: "Check your email"})).toBeVisible();

		await firstPage.goto(await mailboxLink(request, verificationSubject));
		await expect(firstPage.getByRole("heading", {name: "Email verified"})).toBeVisible();
		await firstPage.getByRole("button", {name: "Sign in", exact: true}).click();
		await firstPage.getByRole("textbox", {name: "Email"}).fill(email);
		await firstPage.getByLabel("Password").fill(originalPassword);
		await firstPage.getByRole("button", {name: "Sign in", exact: true}).click();
		await expect(firstPage.getByText(email)).toBeVisible();
		await expect.poll(() => firstHealthyConnectionAttempt).toBe(3);
		await expect(firstPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		const userId = await sessionUserId(firstPage);

		await firstContext.grantPermissions(["clipboard-read", "clipboard-write"]);
		await firstPage.getByRole("button", {name: "Generate and copy pairing code"}).click();
		await expect(firstPage.getByRole("status")).toHaveText("📋 Copied to clipboard");
		const pairingCode = await firstPage.locator("code.pairing-code").textContent();
		if (pairingCode === null) {
			throw new Error("pairing code was not rendered");
		}
		const pairing = await request.post("/api/v1/pair/claim", {
			data: {code: pairingCode, label: "Browser test machine"},
		});
		expect(pairing.status()).toBe(201);
		const machineToken = ((await pairing.json()) as PairingResponse).token;
		await expect(firstPage.getByRole("status")).toHaveText("✓ Machine paired");
		await expect(firstPage.getByText("Browser test machine")).toBeVisible();
		await firstPage.getByRole("button", {name: "Back to the deck"}).click();
		await expect(firstPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		await expect(firstPage.locator(".card, .actions")).toHaveCount(0);
		await expect(firstPage.getByRole("button", {name: "AFK off"})).toHaveAttribute("aria-pressed", "false");

		await firstPage.getByRole("button", {name: "AFK off"}).click();
		await expect(firstPage.getByRole("button", {name: "AFK on"})).toHaveAttribute("aria-pressed", "true");
		const created = await request.post("/api/v1/questions", {
			headers: {Authorization: `Bearer ${machineToken}`},
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

		const summary = await request.get("/api/v1/activity-summary", {
			headers: {Authorization: `Bearer ${machineToken}`},
		});
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

		const secondContext = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(secondContext);
		const secondPage = await secondContext.newPage();
		await signIn(secondPage, originalPassword);
		await expect(secondPage.getByText(email)).toBeVisible();
		await expect(secondPage.getByText("Browser test machine")).toBeVisible();
		await secondPage.getByRole("button", {name: "Sign out"}).click();
		await expect(secondPage).toHaveURL(/\/$/);

		await secondPage.getByRole("button", {name: "Sign in to pair"}).click();
		await expect(secondPage).toHaveURL(/\/sign-in$/);
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await secondPage.getByRole("button", {name: "Forgot password?"}).click();
		await expect(secondPage).toHaveURL(/\/forgot-password$/);
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await secondPage.getByRole("textbox", {name: "Email"}).fill(email);
		await secondPage.getByRole("button", {name: "Send recovery email"}).click();
		await expect(secondPage.getByRole("status")).toHaveText(
			"If that account exists, a recovery email was requested.",
		);
		await secondPage.goto(await mailboxLink(request, resetSubject));
		await expect(secondPage.getByRole("heading", {name: "Choose a new password"})).toBeVisible();
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await secondPage.getByLabel("New password").fill(replacementPassword);
		await secondPage.getByRole("button", {name: "Save new password"}).click();
		await expect(secondPage.getByRole("status")).toHaveText("Your password has been changed.");
		await secondPage.getByRole("button", {name: "Sign in", exact: true}).click();
		await secondPage.getByRole("textbox", {name: "Email"}).fill(email);
		await secondPage.getByLabel("Password").fill(replacementPassword);
		await secondPage.getByRole("button", {name: "Sign in", exact: true}).click();
		await expect(secondPage.getByText("Browser test machine")).toBeVisible();
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);

		const machineRow = secondPage.getByRole("listitem").filter({hasText: "Browser test machine"});
		await machineRow.getByRole("button", {name: "Revoke"}).click();
		await expect(secondPage.getByText("No paired machines.")).toBeVisible();
		await expect(secondPage.getByRole("heading", {name: "Pair a machine"})).toBeVisible();
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);
		await expect(firstPage.getByRole("button", {name: "Pair a machine"})).toBeVisible();
		expect((await request.get("/api/v1/afk", {headers: {Authorization: `Bearer ${machineToken}`}})).status()).toBe(
			401,
		);

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
		await expect(secondPage.getByRole("button", {name: "Sign in to pair"})).toBeVisible();
		await expect(secondPage.locator(".app-header .afk-toggle")).toHaveCount(0);

		const deletedState = await request.post("/api/__e2e__/deleted-account", {data: {user_id: userId}});
		expect({body: await deletedState.json(), status: deletedState.status()}).toStrictEqual({
			body: {cleanup_completed: 1, identity_deleted: 1, machine_tokens: 0, users: 0},
			status: 200,
		});
	} finally {
		await closeContexts(contexts);
	}
});
