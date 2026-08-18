import {runAfkCommand} from "../afk";
import {startMockBackend, type MockBackend} from "./mock-backend";

describe("yepnope-mcp afk", () => {
	let backend: MockBackend | undefined;

	afterEach(async () => {
		await backend?.close();
		backend = undefined;
	});

	it("shows the current status with an authenticated GET", async () => {
		backend = await startMockBackend({afk: true});
		const output = await runAfkCommand([], {
			baseUrl: backend.baseUrl,
			token: "ynp_test_alice_token",
		});
		expect(output).toBe("AFK mode is on. New questions will route to YepNope.\n");
		expect(backend.afkRequests).toStrictEqual([
			{
				method: "GET",
				url: "/api/v1/afk",
				authorization: "Bearer ynp_test_alice_token",
				contentType: undefined,
				body: null,
			},
		]);
	});

	it.each([
		{
			argument: "on",
			afk: true,
			output: "AFK mode is now on. New questions will route to YepNope.\n",
		},
		{
			argument: "off",
			afk: false,
			output: "AFK mode is now off. New questions will use native prompts.\n",
		},
	])("sets AFK mode $argument with an authenticated PUT", async ({argument, afk, output}) => {
		backend = await startMockBackend();
		expect(await runAfkCommand([argument], {baseUrl: backend.baseUrl, token: "ynp_test_alice_token"})).toBe(output);
		expect(backend.afkRequests).toStrictEqual([
			{
				method: "PUT",
				url: "/api/v1/afk",
				authorization: "Bearer ynp_test_alice_token",
				contentType: "application/json",
				body: {afk},
			},
		]);
	});

	it.each([
		{afk: true, output: "📱 YepNope: ON\n"},
		{afk: false, output: "💻 YepNope: OFF\n"},
	])("prints a compact statusline when AFK is $afk", async ({afk, output}) => {
		backend = await startMockBackend({afk});
		expect(await runAfkCommand(["statusline"], {baseUrl: backend.baseUrl, token: "ynp_test_alice_token"})).toBe(
			output,
		);
	});

	it("rejects commands without a token before making a request", async () => {
		await expect(runAfkCommand(["status"], {baseUrl: "https://example.com"})).rejects.toThrow(
			new Error(
				"Neither YEPNOPE_TOKEN nor YEPNOPE_TOKEN_FILE is set. Generate a pairing code in the app, then run " +
					"`npx yepnope-mcp pair <code>` or use its --token-file option.",
			),
		);
	});

	it("prints a visible statusline warning when the token is missing", async () => {
		expect(await runAfkCommand(["statusline"], {baseUrl: "https://example.com"})).toBe(
			"⚠️ YepNope: TOKEN MISSING\n",
		);
	});

	it("reports server errors without exposing the token", async () => {
		backend = await startMockBackend({afkGetStatus: 503});
		const token = "ynp_test_secret_token";
		await expect(runAfkCommand(["status"], {baseUrl: backend.baseUrl, token})).rejects.toThrow(
			new Error("AFK request failed: the server answered HTTP 503."),
		);
	});

	it("explains that pairing is required before AFK can be enabled", async () => {
		backend = await startMockBackend({
			afkPutStatus: 409,
			afkPutBody: {error: "pairing_required", message: "Connect a CLI before turning AFK on."},
		});
		await expect(runAfkCommand(["on"], {baseUrl: backend.baseUrl, token: "ynp_test_alice_token"})).rejects.toThrow(
			new Error("Connect a CLI before turning AFK on."),
		);
	});

	it("prints a visible statusline warning when the server is unavailable", async () => {
		backend = await startMockBackend({afkGetStatus: 503});
		expect(await runAfkCommand(["statusline"], {baseUrl: backend.baseUrl, token: "ynp_test_alice_token"})).toBe(
			"⚠️ YepNope: UNKNOWN (HTTP 503)\n",
		);
	});

	it("rejects an unsupported action", async () => {
		await expect(
			runAfkCommand(["toggle"], {baseUrl: "https://example.com", token: "ynp_test_alice_token"}),
		).rejects.toThrow(new Error("usage: yepnope-mcp afk [status|on|off|statusline]"));
	});
});
