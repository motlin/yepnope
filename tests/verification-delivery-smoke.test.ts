import {describe, expect, it, vi} from "vitest";
import {
	runVerificationDeliverySmoke,
	type AccountState,
	type VerificationDeliveryEnvironment,
} from "../scripts/verification-delivery-smoke";

const TEST_ENVIRONMENT = {
	CLOUDFLARE_ACCOUNT_ID: "example-account-id",
	CLOUDFLARE_API_TOKEN: "example-cloudflare-api-token",
	CLOUDFLARE_ZONE_ID: "example-zone-id",
	YEPNOPE_D1_DATABASE_ID: "example-database-id",
	YEPNOPE_SENDING_DOMAIN: "yepnope.app",
} satisfies VerificationDeliveryEnvironment;

const CHECKED_AT = "2026-08-19T12:00:00.000Z";

const HEALTHY_ACCOUNT_STATE: AccountState = {
	live_verification_tokens: 1,
	unverified_users: 1,
	users: 4,
	verification_tokens: 1,
	verified_users: 3,
};

function sendingDomains(names: string[]): Response {
	return Response.json({success: true, result: names.map((name) => ({name}))});
}

function emailActivity(groups: Array<{count: number; status: string}>): Response {
	return Response.json({
		data: {
			viewer: {
				zones: [
					{
						emailSendingAdaptiveGroups: groups.map(({count, status}) => ({
							count,
							dimensions: {status},
						})),
					},
				],
			},
		},
	});
}

function accountState(state: AccountState): Response {
	return Response.json({success: true, result: [{success: true, results: [state]}]});
}

function smokeFetch(responses: Response[]) {
	const request = vi.fn<typeof fetch>();
	for (const response of responses) {
		request.mockResolvedValueOnce(response);
	}
	return request;
}

async function runSmoke(request: ReturnType<typeof smokeFetch>) {
	return runVerificationDeliverySmoke(TEST_ENVIRONMENT, {
		fetch: request,
		now: () => new Date(CHECKED_AT),
	});
}

describe("production verification-delivery smoke", () => {
	it("reports a healthy sending domain, activity, and token state", async () => {
		const request = smokeFetch([
			sendingDomains(["yepnope.app"]),
			emailActivity([
				{count: 12, status: "delivered"},
				{count: 1, status: "sent"},
			]),
			accountState(HEALTHY_ACCOUNT_STATE),
		]);

		expect(await runSmoke(request)).toStrictEqual({
			account_state: HEALTHY_ACCOUNT_STATE,
			checked_at: CHECKED_AT,
			email_activity: [
				{count: 12, status: "delivered"},
				{count: 1, status: "sent"},
			],
			findings: [],
			sending_domain_onboarded: true,
			sending_domains: ["yepnope.app"],
			status: "healthy",
			window_days: 7,
		});
		expect(
			request.mock.calls.map(
				([input]) => new URL(input instanceof Request ? input.url : input.toString()).pathname,
			),
		).toStrictEqual([
			"/client/v4/accounts/example-account-id/email/sending/subdomains",
			"/client/v4/graphql",
			"/client/v4/accounts/example-account-id/d1/database/example-database-id/query",
		]);
	});

	it("names the un-onboarded sending domain that strands every new recipient", async () => {
		const request = smokeFetch([
			sendingDomains(["unrelated.example"]),
			emailActivity([{count: 3, status: "delivered"}]),
			accountState({...HEALTHY_ACCOUNT_STATE, live_verification_tokens: 0, unverified_users: 2}),
		]);

		expect(await runSmoke(request)).toStrictEqual({
			account_state: {...HEALTHY_ACCOUNT_STATE, live_verification_tokens: 0, unverified_users: 2},
			checked_at: CHECKED_AT,
			email_activity: [{count: 3, status: "delivered"}],
			findings: [
				"yepnope.app is not onboarded to Cloudflare Email Service, so only verified destination " +
					"addresses in this account can receive authentication email",
				"2 unverified accounts hold no live verification token",
			],
			sending_domain_onboarded: false,
			sending_domains: ["unrelated.example"],
			status: "degraded",
			window_days: 7,
		});
	});

	it("flags failed and rejected sends recorded in the activity window", async () => {
		const request = smokeFetch([
			sendingDomains(["yepnope.app"]),
			emailActivity([
				{count: 5, status: "delivered"},
				{count: 2, status: "deliveryFailed"},
				{count: 1, status: "rejected"},
			]),
			accountState(HEALTHY_ACCOUNT_STATE),
		]);

		expect(await runSmoke(request)).toStrictEqual({
			account_state: HEALTHY_ACCOUNT_STATE,
			checked_at: CHECKED_AT,
			email_activity: [
				{count: 5, status: "delivered"},
				{count: 2, status: "deliveryFailed"},
				{count: 1, status: "rejected"},
			],
			findings: ["3 of 8 sends in the last 7 days did not reach their recipient"],
			sending_domain_onboarded: true,
			sending_domains: ["yepnope.app"],
			status: "degraded",
			window_days: 7,
		});
	});

	it("reports no send activity at all as a delivery outage", async () => {
		const request = smokeFetch([
			sendingDomains(["yepnope.app"]),
			emailActivity([]),
			accountState({...HEALTHY_ACCOUNT_STATE, live_verification_tokens: 0, unverified_users: 0}),
		]);

		expect(await runSmoke(request)).toStrictEqual({
			account_state: {...HEALTHY_ACCOUNT_STATE, live_verification_tokens: 0, unverified_users: 0},
			checked_at: CHECKED_AT,
			email_activity: [],
			findings: ["Cloudflare Email Service recorded no sends in the last 7 days"],
			sending_domain_onboarded: true,
			sending_domains: ["yepnope.app"],
			status: "degraded",
			window_days: 7,
		});
	});

	it("queries the activity window and the token state without naming a person", async () => {
		const request = smokeFetch([
			sendingDomains(["yepnope.app"]),
			emailActivity([{count: 1, status: "delivered"}]),
			accountState(HEALTHY_ACCOUNT_STATE),
		]);

		const report = await runSmoke(request);

		const [, activityCall, stateCall] = request.mock.calls;
		expect({
			activityVariables: JSON.parse(String(activityCall?.[1]?.body)).variables,
			reportMentionsAnAddress: /@|token=|[0-9a-f]{32}/.test(JSON.stringify(report)),
			// 🙈 The smoke check counts rows; it never selects an identifier, a value, or an address.
			stateSql: JSON.parse(String(stateCall?.[1]?.body)).sql,
		}).toStrictEqual({
			activityVariables: {end: "2026-08-19", start: "2026-08-12", zoneTag: "example-zone-id"},
			reportMentionsAnAddress: false,
			stateSql:
				"SELECT (SELECT count(*) FROM user) AS users, " +
				"(SELECT count(*) FROM user WHERE email_verified = 1) AS verified_users, " +
				"(SELECT count(*) FROM user WHERE email_verified = 0) AS unverified_users, " +
				"(SELECT count(*) FROM verification " +
				"WHERE identifier LIKE 'yepnope-email-verification:%') AS verification_tokens, " +
				"(SELECT count(*) FROM verification " +
				"WHERE identifier LIKE 'yepnope-email-verification:%' AND expires_at > ?) AS live_verification_tokens",
		});
	});

	it("refuses to report a Cloudflare response it cannot trust", async () => {
		const request = smokeFetch([Response.json({success: false, errors: [{message: "denied"}]}, {status: 403})]);

		await expect(runSmoke(request)).rejects.toThrow("request failed with HTTP 403");
	});
});
