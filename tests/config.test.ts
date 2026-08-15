import {describe, it, expect, beforeEach, vi} from "vitest";
import {loadConfig, validateConfig, type Config} from "../src/config.js";

describe("Config module", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = {...originalEnv};
	});

	describe("loadConfig", () => {
		it("returns default config when no overrides provided", () => {
			delete process.env["NODE_ENV"];
			const config = loadConfig();

			expect(config.appName).toBe("YepNope");
			expect(config.version).toBe("1.0.0");
			expect(config.environment).toBe("development");
			expect(config.port).toBe(3000);
			expect(config.apiUrl).toBe("http://localhost:3000/api");
			expect(config.features.enableLogging).toBe(true);
			expect(config.features.enableMetrics).toBe(false);
			expect(config.features.enableDebug).toBe(true);
		});

		it("applies overrides to config", () => {
			const overrides: Partial<Config> = {
				appName: "Custom App",
				port: 8080,
				features: {
					enableLogging: false,
					enableMetrics: true,
					enableDebug: false,
				},
			};

			const config = loadConfig(overrides);

			expect(config.appName).toBe("Custom App");
			expect(config.port).toBe(8080);
			expect(config.features.enableLogging).toBe(false);
			expect(config.features.enableMetrics).toBe(true);
		});

		it("reads environment variables", () => {
			process.env["NODE_ENV"] = "production";
			process.env["PORT"] = "5000";
			process.env["API_URL"] = "https://api.production.com";

			const config = loadConfig();

			expect(config.environment).toBe("production");
			expect(config.port).toBe(5000);
			expect(config.apiUrl).toBe("https://api.production.com");
		});

		it("prioritizes overrides over environment variables", () => {
			process.env["PORT"] = "5000";

			const config = loadConfig({port: 8080});

			expect(config.port).toBe(8080);
		});
	});

	describe("validateConfig", () => {
		it("validates correct config", () => {
			const config: Config = {
				appName: "Test App",
				version: "1.0.0",
				environment: "development",
				port: 3000,
				apiUrl: "http://localhost:3000",
				features: {
					enableLogging: true,
					enableMetrics: false,
					enableDebug: true,
				},
			};

			expect(() => {
				validateConfig(config);
			}).not.toThrow();
		});

		it("throws for invalid port numbers", () => {
			const invalidPorts = [0, -1, 65536, 100000];

			for (const port of invalidPorts) {
				const config = loadConfig({port});
				expect(() => {
					validateConfig(config);
				}).toThrow(`Invalid port: ${port}`);
			}
		});

		it("throws for invalid API URLs", () => {
			const invalidUrls = ["not-a-url", "http://", "ftp//missing-colon"];

			for (const apiUrl of invalidUrls) {
				const config = loadConfig({apiUrl});
				expect(() => {
					validateConfig(config);
				}).toThrow(`Invalid API URL: ${apiUrl}`);
			}
		});

		it("accepts valid URLs", () => {
			const validUrls = ["http://localhost:3000", "https://api.example.com", "http://192.168.1.1:8080/api"];

			for (const apiUrl of validUrls) {
				const config = loadConfig({apiUrl});
				expect(() => {
					validateConfig(config);
				}).not.toThrow();
			}
		});
	});
});
