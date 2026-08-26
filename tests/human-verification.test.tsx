// @vitest-environment project-jsdom
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {useState, type ReactElement} from "react";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {HumanVerificationField} from "../src/human-verification";
import type {ResolvedTheme} from "../src/theme";
import {humanVerificationBlocksSubmit, useHumanVerification} from "../src/turnstile";

const TEST_SITE_KEY = "1x00000000000000000000AA";

interface StubRenderOptions {
	action: string;
	appearance: string;
	callback: (token: string) => void;
	"error-callback": () => void;
	"expired-callback": () => void;
	"refresh-expired": string;
	retry: string;
	sitekey: string;
	size: string;
	theme: string;
	"timeout-callback": () => void;
}

interface TurnstileStub {
	options: () => StubRenderOptions;
	removals: string[];
	resets: string[];
	widgetCount: () => number;
}

/**
 * Cloudflare's widget script, reduced to the surface this module actually uses. The test drives the
 * callbacks itself, so every state the visitor can land in is reached deterministically.
 */
function installTurnstileStub(): TurnstileStub {
	const rendered: StubRenderOptions[] = [];
	const removals: string[] = [];
	const resets: string[] = [];
	let counter = 0;
	window.turnstile = {
		remove: (widgetId) => {
			removals.push(widgetId);
		},
		render: (container, options) => {
			counter += 1;
			const frame = document.createElement("div");
			frame.textContent = "Cloudflare Turnstile challenge";
			container.append(frame);
			rendered.push(options);
			return `widget-${counter}`;
		},
		reset: (widgetId) => {
			resets.push(widgetId);
		},
	};
	return {
		options: () => {
			const latest = rendered.at(-1);
			if (latest === undefined) {
				throw new Error("the widget was never rendered");
			}
			return latest;
		},
		removals,
		resets,
		widgetCount: () => rendered.length,
	};
}

interface HarnessProps {
	action?: string;
	siteKey: string | null;
	theme?: ResolvedTheme;
}

function Harness({action = "sign_in", siteKey, theme = "dark"}: HarnessProps): ReactElement {
	const verification = useHumanVerification(action, siteKey, theme);
	const [outcome, setOutcome] = useState("idle");
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				setOutcome("submitting");
				void verification.consume().then(
					(token) => {
						setOutcome(token ?? "waived");
					},
					() => {
						setOutcome("refused");
					},
				);
			}}
		>
			<HumanVerificationField verification={verification} />
			<button type="submit" disabled={humanVerificationBlocksSubmit(verification)}>
				Submit
			</button>
			<p data-testid="outcome">{outcome}</p>
		</form>
	);
}

function submitButton(): HTMLButtonElement {
	return screen.getByRole("button", {name: "Submit"});
}

function outcome(): string {
	return screen.getByTestId("outcome").textContent;
}

function status(): string {
	return screen.getByRole("status").textContent;
}

beforeEach(() => {
	delete window.turnstile;
});

afterEach(() => {
	delete window.turnstile;
	for (const script of document.querySelectorAll("script")) {
		script.remove();
	}
});

describe("A deployment that configured no widget", () => {
	it("draws no check and lets the form submit with no token", async () => {
		render(<Harness siteKey={null} />);

		expect({
			blocked: submitButton().disabled,
			group: screen.queryByRole("group", {name: "Human verification"}),
		}).toStrictEqual({blocked: false, group: null});

		fireEvent.submit(submitButton());

		await waitFor(() => {
			expect(outcome()).toBe("waived");
		});
	});
});

describe("The human-verification check", () => {
	it("renders one dark, flexible widget that names its own surface", async () => {
		const turnstile = installTurnstileStub();

		render(<Harness action="reset_password" siteKey={TEST_SITE_KEY} />);

		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});
		const options = turnstile.options();
		expect({
			action: options.action,
			appearance: options.appearance,
			refreshExpired: options["refresh-expired"],
			retry: options.retry,
			sitekey: options.sitekey,
			size: options.size,
			theme: options.theme,
		}).toStrictEqual({
			action: "reset_password",
			appearance: "always",
			refreshExpired: "auto",
			retry: "never",
			sitekey: TEST_SITE_KEY,
			size: "flexible",
			theme: "dark",
		});
	});

	// 🌗 Cloudflare draws the widget itself, so the only way it can match a light page is to be told.
	it("draws the widget in the palette the page is painted in, and redraws it when that changes", async () => {
		const turnstile = installTurnstileStub();

		const view = render(<Harness siteKey={TEST_SITE_KEY} theme="light" />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});
		expect(turnstile.options().theme).toBe("light");

		view.rerender(<Harness siteKey={TEST_SITE_KEY} theme="dark" />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(2);
		});
		expect({removals: turnstile.removals, theme: turnstile.options().theme}).toStrictEqual({
			removals: ["widget-1"],
			theme: "dark",
		});
	});

	it("holds the submit until the check reports a token, then releases it", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(status()).toBe("Checking that you are human…");
		});

		expect(submitButton().disabled).toBe(true);
		act(() => {
			turnstile.options().callback("solved-token");
		});

		expect({blocked: submitButton().disabled, status: status()}).toStrictEqual({
			blocked: false,
			status: "Human verification complete.",
		});
	});

	// 🎟️ A token is redeemable exactly once, so handing it over must start the next one.
	it("spends the held token on the submission and immediately earns a replacement", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});
		act(() => {
			turnstile.options().callback("first-token");
		});

		fireEvent.submit(submitButton());

		await waitFor(() => {
			expect(outcome()).toBe("first-token");
		});
		expect({blocked: submitButton().disabled, resets: turnstile.resets.length}).toStrictEqual({
			blocked: true,
			resets: 1,
		});

		act(() => {
			turnstile.options().callback("second-token");
		});
		fireEvent.submit(submitButton());
		await waitFor(() => {
			expect(outcome()).toBe("second-token");
		});
	});

	it("makes a submission wait for a check that has not finished yet", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});

		// The form element ignores the button's disabled state, standing in for a visitor who
		// submitted with the keyboard the instant before the widget answered.
		fireEvent.submit(submitButton());
		expect(outcome()).toBe("submitting");

		act(() => {
			turnstile.options().callback("late-token");
		});

		await waitFor(() => {
			expect(outcome()).toBe("late-token");
		});
	});

	it("says an expired check is being rerun, and clears the notice when it is", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});
		act(() => {
			turnstile.options().callback("aging-token");
		});

		act(() => {
			turnstile.options()["expired-callback"]();
		});
		const expired = {blocked: submitButton().disabled, status: status()};

		act(() => {
			turnstile.options().callback("fresh-token");
		});

		expect({expired, refreshed: {blocked: submitButton().disabled, status: status()}}).toStrictEqual({
			expired: {blocked: true, status: "That check expired. Running it again…"},
			refreshed: {blocked: false, status: "Human verification complete."},
		});
	});

	it("explains a refused check and rebuilds the widget when the visitor retries", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});

		act(() => {
			turnstile.options()["error-callback"]();
		});

		expect({
			alert: screen.getByRole("alert").textContent,
			blocked: submitButton().disabled,
		}).toStrictEqual({
			alert: "We could not verify this browser. Retry the check below, then submit again.",
			blocked: true,
		});

		fireEvent.click(screen.getByRole("button", {name: "Retry verification"}));

		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(2);
		});
		expect(turnstile.removals).toStrictEqual(["widget-1"]);
	});

	it("refuses a submission that was already waiting when the check failed", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});

		fireEvent.submit(submitButton());
		act(() => {
			turnstile.options()["timeout-callback"]();
		});

		await waitFor(() => {
			expect(outcome()).toBe("refused");
		});
	});

	// 🕸️ Turnstile's script is a third-party request that an extension, a proxy, or a flaky network
	// can simply not deliver. The page has to say so rather than present a form that cannot work.
	it("reports a script that never loads instead of waiting silently", async () => {
		render(<Harness siteKey={TEST_SITE_KEY} />);

		const script = await waitFor(() => {
			const candidate = document.querySelector<HTMLScriptElement>(
				'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]',
			);
			if (candidate === null) {
				throw new Error("the widget script was never requested");
			}
			return candidate;
		});
		expect({
			async: script.async,
			defer: script.defer,
			explicit: script.src.includes("render=explicit"),
		}).toStrictEqual({async: true, defer: true, explicit: true});

		act(() => {
			script.dispatchEvent(new Event("error"));
		});

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe(
				"We could not verify this browser. Retry the check below, then submit again.",
			);
		});
		expect(submitButton().disabled).toBe(true);
	});
});

describe("The check as a screen reader and a keyboard reach it", () => {
	it("names its group, announces politely, and discloses who is doing the checking", async () => {
		installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);

		const group = await screen.findByRole("group", {name: "Human verification"});
		const announcement = screen.getByRole("status");

		expect({
			busyWhileWorking: announcement.getAttribute("aria-busy"),
			disclosesProcessor: group.textContent.includes("Cloudflare Turnstile checks this browser"),
			live: announcement.getAttribute("aria-live"),
			privacyLink: group.querySelector('a[href="https://www.cloudflare.com/privacypolicy/"]') !== null,
			promisesNoPassword: group.textContent.includes("It never receives your password."),
			termsLink: group.querySelector('a[href="https://www.cloudflare.com/website-terms/"]') !== null,
		}).toStrictEqual({
			busyWhileWorking: "true",
			disclosesProcessor: true,
			live: "polite",
			privacyLink: true,
			promisesNoPassword: true,
			termsLink: true,
		});
	});

	it("offers the retry as a real button the keyboard can reach", async () => {
		const turnstile = installTurnstileStub();
		render(<Harness siteKey={TEST_SITE_KEY} />);
		await waitFor(() => {
			expect(turnstile.widgetCount()).toBe(1);
		});

		act(() => {
			turnstile.options()["error-callback"]();
		});
		const retry = screen.getByRole("button", {name: "Retry verification"});

		expect({tabbable: retry.getAttribute("tabindex"), type: retry.getAttribute("type")}).toStrictEqual({
			tabbable: null,
			type: "button",
		});
	});
});
