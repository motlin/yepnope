export interface Config {
	appName: string;
	version: string;
	environment: "development" | "staging" | "production";
	port: number;
	apiUrl: string;
	features: {
		enableLogging: boolean;
		enableMetrics: boolean;
		enableDebug: boolean;
	};
}

const defaultConfig: Config = {
	appName: "YepNope",
	version: "1.0.0",
	environment: "development",
	port: 3000,
	apiUrl: "http://localhost:3000/api",
	features: {
		enableLogging: true,
		enableMetrics: false,
		enableDebug: true,
	},
};

const environments: ReadonlyArray<Config["environment"]> = ["development", "staging", "production"];

function parseEnvironment(value: string | undefined): Config["environment"] | undefined {
	return environments.find((candidate) => candidate === value);
}

export function loadConfig(overrides?: Partial<Config>): Config {
	const environment = overrides?.environment ?? parseEnvironment(process.env["NODE_ENV"]) ?? "development";
	const envPort = process.env["PORT"];
	const port =
		overrides?.port ??
		(envPort !== undefined && envPort !== "" ? Number(envPort) : undefined) ??
		defaultConfig.port;
	const apiUrl = overrides?.apiUrl ?? process.env["API_URL"] ?? defaultConfig.apiUrl;

	return {
		...defaultConfig,
		...overrides,
		environment,
		port,
		apiUrl,
	};
}

export function validateConfig(config: Config): void {
	if (Number.isNaN(config.port) || config.port < 1 || config.port > 65535) {
		throw new Error(`Invalid port: ${config.port}`);
	}

	try {
		new URL(config.apiUrl);
	} catch {
		throw new Error(`Invalid API URL: ${config.apiUrl}`);
	}
}
