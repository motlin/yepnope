import {pathToFileURL} from "node:url";
import {z} from "zod";

/**
 * 🔍 Production smoke check for authentication-email delivery.
 *
 * The Worker deliberately answers every verification request with the same accepted body, so the
 * browser can never tell a stranded new account from a healthy one. This script asks the three
 * questions the browser cannot: is a sending domain onboarded to Cloudflare Email Service, what did
 * Email Service actually do with recent sends, and does D1 hold a live token for the accounts still
 * waiting to verify. It counts rows and groups events; it never reads an address, a link, or a token.
 */

const ACTIVITY_WINDOW_DAYS = 7;
const VERIFICATION_IDENTIFIER_PREFIX = "yepnope-email-verification:";
const DELIVERED_EMAIL_STATUSES: ReadonlySet<string> = new Set(["delivered", "sent"]);

const ACCOUNT_STATE_SQL =
	"SELECT (SELECT count(*) FROM user) AS users, " +
	"(SELECT count(*) FROM user WHERE email_verified = 1) AS verified_users, " +
	"(SELECT count(*) FROM user WHERE email_verified = 0) AS unverified_users, " +
	`(SELECT count(*) FROM verification WHERE identifier LIKE '${VERIFICATION_IDENTIFIER_PREFIX}%') ` +
	"AS verification_tokens, " +
	`(SELECT count(*) FROM verification WHERE identifier LIKE '${VERIFICATION_IDENTIFIER_PREFIX}%' ` +
	"AND expires_at > ?) AS live_verification_tokens";

const EMAIL_ACTIVITY_QUERY = `query EmailSendingActivity($zoneTag: string!, $start: Date!, $end: Date!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      emailSendingAdaptiveGroups(filter: {date_geq: $start, date_leq: $end}, limit: 1000, orderBy: [count_DESC]) {
        count
        dimensions {
          status
        }
      }
    }
  }
}`;

const environmentSchema = z.object({
	CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
	CLOUDFLARE_API_TOKEN: z.string().min(1),
	CLOUDFLARE_ZONE_ID: z.string().min(1),
	YEPNOPE_D1_DATABASE_ID: z.string().min(1),
	YEPNOPE_SENDING_DOMAIN: z.string().min(1),
});

const sendingDomainsSchema = z.object({
	success: z.literal(true),
	result: z.array(z.object({name: z.string()})),
});

const emailActivitySchema = z.object({
	data: z.object({
		viewer: z.object({
			zones: z.array(
				z.object({
					emailSendingAdaptiveGroups: z.array(
						z.object({count: z.number().int().nonnegative(), dimensions: z.object({status: z.string()})}),
					),
				}),
			),
		}),
	}),
});

const accountStateSchema = z.object({
	success: z.literal(true),
	result: z.tuple([
		z.object({
			success: z.literal(true),
			results: z.tuple([
				z.object({
					live_verification_tokens: z.number().int().nonnegative(),
					unverified_users: z.number().int().nonnegative(),
					users: z.number().int().nonnegative(),
					verification_tokens: z.number().int().nonnegative(),
					verified_users: z.number().int().nonnegative(),
				}),
			]),
		}),
	]),
});

export type VerificationDeliveryEnvironment = z.infer<typeof environmentSchema>;
export type AccountState = z.infer<typeof accountStateSchema>["result"][0]["results"][0];

export interface VerificationDeliveryDependencies {
	fetch: typeof fetch;
	now: () => Date;
}

export interface EmailActivityGroup {
	count: number;
	status: string;
}

export interface VerificationDeliveryReport {
	account_state: AccountState;
	checked_at: string;
	email_activity: EmailActivityGroup[];
	findings: string[];
	sending_domain_onboarded: boolean;
	sending_domains: string[];
	status: "degraded" | "healthy";
	window_days: number;
}

function cloudflareUrl(path: string): URL {
	return new URL(path, "https://api.cloudflare.com");
}

async function cloudflareJson(
	environment: VerificationDeliveryEnvironment,
	request: typeof fetch,
	url: URL,
	body?: unknown,
): Promise<unknown> {
	const headers = new Headers({Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`});
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const response = await request(url, {
		method: body === undefined ? "GET" : "POST",
		headers,
		...(body === undefined ? {} : {body: JSON.stringify(body)}),
	});
	if (!response.ok) {
		throw new Error(`request failed with HTTP ${response.status}`);
	}
	return response.json();
}

function isoDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

async function readSendingDomains(
	environment: VerificationDeliveryEnvironment,
	request: typeof fetch,
): Promise<string[]> {
	const response = sendingDomainsSchema.parse(
		await cloudflareJson(
			environment,
			request,
			cloudflareUrl(`/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/email/sending/subdomains`),
		),
	);
	return response.result.map(({name}) => name);
}

async function readEmailActivity(
	environment: VerificationDeliveryEnvironment,
	dependencies: VerificationDeliveryDependencies,
): Promise<EmailActivityGroup[]> {
	const end = dependencies.now();
	const start = new Date(end.getTime() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
	const response = emailActivitySchema.parse(
		await cloudflareJson(environment, dependencies.fetch, cloudflareUrl("/client/v4/graphql"), {
			query: EMAIL_ACTIVITY_QUERY,
			variables: {end: isoDate(end), start: isoDate(start), zoneTag: environment.CLOUDFLARE_ZONE_ID},
		}),
	);
	return response.data.viewer.zones.flatMap((zone) =>
		zone.emailSendingAdaptiveGroups.map(({count, dimensions}) => ({count, status: dimensions.status})),
	);
}

async function readAccountState(
	environment: VerificationDeliveryEnvironment,
	dependencies: VerificationDeliveryDependencies,
): Promise<AccountState> {
	const response = accountStateSchema.parse(
		await cloudflareJson(
			environment,
			dependencies.fetch,
			cloudflareUrl(
				`/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/d1/database/` +
					`${environment.YEPNOPE_D1_DATABASE_ID}/query`,
			),
			{params: [String(dependencies.now().getTime())], sql: ACCOUNT_STATE_SQL},
		),
	);
	return response.result[0].results[0];
}

function deliveryFindings(
	environment: VerificationDeliveryEnvironment,
	sendingDomains: string[],
	activity: EmailActivityGroup[],
	accountState: AccountState,
): string[] {
	const findings: string[] = [];
	if (!sendingDomains.includes(environment.YEPNOPE_SENDING_DOMAIN)) {
		findings.push(
			`${environment.YEPNOPE_SENDING_DOMAIN} is not onboarded to Cloudflare Email Service, so only verified ` +
				"destination addresses in this account can receive authentication email",
		);
	}
	const sends = activity.reduce((total, {count}) => total + count, 0);
	const undelivered = activity
		.filter(({status}) => !DELIVERED_EMAIL_STATUSES.has(status))
		.reduce((total, {count}) => total + count, 0);
	if (sends === 0) {
		findings.push(`Cloudflare Email Service recorded no sends in the last ${ACTIVITY_WINDOW_DAYS} days`);
	} else if (undelivered > 0) {
		findings.push(
			`${undelivered} of ${sends} sends in the last ${ACTIVITY_WINDOW_DAYS} days did not reach their recipient`,
		);
	}
	if (accountState.unverified_users > accountState.live_verification_tokens) {
		findings.push(
			`${accountState.unverified_users - accountState.live_verification_tokens} unverified accounts hold no ` +
				"live verification token",
		);
	}
	return findings;
}

export async function runVerificationDeliverySmoke(
	environment: VerificationDeliveryEnvironment,
	dependencies: VerificationDeliveryDependencies,
): Promise<VerificationDeliveryReport> {
	const sendingDomains = await readSendingDomains(environment, dependencies.fetch);
	const emailActivity = await readEmailActivity(environment, dependencies);
	const accountState = await readAccountState(environment, dependencies);
	const findings = deliveryFindings(environment, sendingDomains, emailActivity, accountState);
	return {
		account_state: accountState,
		checked_at: dependencies.now().toISOString(),
		email_activity: emailActivity,
		findings,
		sending_domain_onboarded: sendingDomains.includes(environment.YEPNOPE_SENDING_DOMAIN),
		sending_domains: sendingDomains,
		status: findings.length === 0 ? "healthy" : "degraded",
		window_days: ACTIVITY_WINDOW_DAYS,
	};
}

async function main(): Promise<void> {
	const report = await runVerificationDeliverySmoke(environmentSchema.parse(process.env), {
		fetch,
		now: () => new Date(),
	});
	console.log(JSON.stringify(report, null, 2));
	if (report.status === "degraded") {
		process.exitCode = 1;
	}
}

const entryPath = process.argv.at(1);
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	await main();
}
