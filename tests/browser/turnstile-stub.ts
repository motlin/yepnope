// 🧪 Cloudflare's widget script, replaced by a local stand-in for the browser suite. The page still
// requests the real URL and still receives an explicit-render `window.turnstile`; only the origin of
// the answer changes, so the suite stays offline and every branch — solved, blocked, interactive,
// expired — is reachable on demand instead of by luck.
//
// Tokens carry the same claims the Worker's test Siteverify reads back, so a token minted here is
// redeemed for real, exactly once, by the Worker under test.

/** How the stubbed widget behaves. Set on `window` before the page loads. */
export type TurnstileStubBehavior = "blocks" | "interactive" | "passes";

export const TURNSTILE_SCRIPT_PATTERN = "https://challenges.cloudflare.com/turnstile/v0/api.js**";

export const TURNSTILE_STUB_SCRIPT = String.raw`
(() => {
	const TOKEN_PREFIX = "yepnope-test-turnstile.";
	const widgets = new Map();
	let counter = 0;

	const behavior = () => window.__turnstileStubBehavior ?? "passes";

	const mintToken = (options) => {
		counter += 1;
		return (
			TOKEN_PREFIX +
			btoa(
				JSON.stringify({
					action: options.action,
					hostname: window.location.hostname,
					nonce: "stub-" + counter,
				}),
			)
		);
	};

	const draw = (widgetId) => {
		const widget = widgets.get(widgetId);
		if (widget === undefined) {
			return;
		}
		const {container, options} = widget;
		container.replaceChildren();
		const frame = document.createElement("div");
		frame.className = "turnstile-stub";
		frame.setAttribute("data-turnstile-stub", options.action);
		container.append(frame);
		const mode = behavior();
		if (mode === "blocks") {
			frame.textContent = "Verification unavailable";
			window.setTimeout(() => options["error-callback"](), 0);
			return;
		}
		if (mode === "interactive") {
			const control = document.createElement("button");
			control.type = "button";
			control.textContent = "Verify you are human";
			control.addEventListener("click", () => {
				frame.replaceChildren(document.createTextNode("Verified"));
				options.callback(mintToken(options));
			});
			frame.append(control);
			return;
		}
		frame.textContent = "Cloudflare Turnstile";
		window.setTimeout(() => options.callback(mintToken(options)), 0);
	};

	window.turnstile = {
		render: (container, options) => {
			counter += 1;
			const widgetId = "stub-widget-" + counter;
			widgets.set(widgetId, {container, options});
			draw(widgetId);
			return widgetId;
		},
		remove: (widgetId) => {
			widgets.get(widgetId)?.container.replaceChildren();
			widgets.delete(widgetId);
		},
		reset: (widgetId) => {
			draw(widgetId);
		},
	};

	// The real widget ages a token out and, with refresh-expired auto, earns a replacement. The
	// suite triggers that sequence rather than waiting the several minutes it actually takes.
	window.__turnstileStubExpire = () => {
		for (const [widgetId, widget] of widgets) {
			widget.options["expired-callback"]();
			window.setTimeout(() => draw(widgetId), 0);
		}
	};
})();
`;
