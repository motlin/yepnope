import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {createPhonePairing, consumePhonePairing, generatePairingCode, normalizePairingCode} from "../phone-pairing";
import {API_ORIGIN, cookieFrom, createVerifiedBrowserSession, postAuthentication, worker} from "./helpers";

const NOW = Date.UTC(2000, 0, 1);

async function desktop() {
	const account = await createVerifiedBrowserSession();
	const response = await worker.fetch(`${API_ORIGIN}/api/auth/get-session`, {headers: {Cookie: account.cookie}});
	const {session} = await response.json<{session: {id: string}}>();
	return {...account, sessionId: session.id};
}

describe("phone pairing codes", () => {
	it("generates eight characters without confusable glyphs", () => {
		const codes = Array.from({length: 100}, () => generatePairingCode());
		expect(codes.every((code) => /^[23456789ABCDEFGHJKMNPQRSTWXYZ]{8}$/.test(code))).toBe(true);
		expect(new Set(codes).size).toBe(100);
	});
	it("normalizes case, spaces and dashes but rejects other punctuation", () => {
		expect([
			normalizePairingCode(" abcd-23xy "),
			normalizePairingCode("ABCD/23XY"),
			normalizePairingCode("O123-ABCD"),
		]).toStrictEqual(["ABCD23XY", null, null]);
	});
	it("expires at ten minutes and stores only the pairing code hash", async () => {
		const account = await desktop();
		const pairing = await createPhonePairing(env.DB, account.sessionId, NOW);
		const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM phone_pairing WHERE id = ?")
			.bind(pairing.id)
			.first<{code_hash: string; expires_at: number; attempts: number}>();
		expect(row?.code_hash === pairing.code).toBe(false);
		expect({expiresAt: row?.expires_at, attempts: row?.attempts, hashLength: row?.code_hash.length}).toStrictEqual({
			expiresAt: NOW + 600_000,
			attempts: 0,
			hashLength: 64,
		});
		expect(await consumePhonePairing(env.DB, pairing.id, pairing.code, NOW + 600_000)).toBe(null);
	});
	it("destroys a code after five wrong attempts", async () => {
		const account = await desktop();
		const pairing = await createPhonePairing(env.DB, account.sessionId, NOW);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(await consumePhonePairing(env.DB, pairing.id, "wrong", NOW)).toBe(null);
		}
		expect(await consumePhonePairing(env.DB, pairing.id, pairing.code, NOW)).toBe(null);
		expect(await env.DB.prepare("SELECT id FROM phone_pairing WHERE id = ?").bind(pairing.id).first()).toBe(null);
	});
	it("keeps a valid code usable after four wrong attempts", async () => {
		const account = await desktop();
		const pairing = await createPhonePairing(env.DB, account.sessionId, NOW);
		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(await consumePhonePairing(env.DB, pairing.id, "wrong", NOW)).toBe(null);
		}
		expect(await consumePhonePairing(env.DB, pairing.id, pairing.code, NOW)).toBe(account.userId);
	});
	it("rejects an expired source session or an account that is no longer verified", async () => {
		const account = await desktop();
		const pairing = await createPhonePairing(env.DB, account.sessionId, NOW);
		await env.DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?").bind(NOW, account.sessionId).run();
		expect(await consumePhonePairing(env.DB, pairing.id, pairing.code, NOW)).toBe(null);
		await env.DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?")
			.bind(NOW + 600_000, account.sessionId)
			.run();
		await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?").bind(account.userId).run();
		expect(await consumePhonePairing(env.DB, pairing.id, pairing.code, NOW)).toBe(null);
	});

	it("allows one redemption, normalizes input, and invalidates older codes", async () => {
		const account = await desktop();
		const old = await createPhonePairing(env.DB, account.sessionId, NOW);
		const pairing = await createPhonePairing(env.DB, account.sessionId, NOW);
		expect(await consumePhonePairing(env.DB, old.id, old.code, NOW)).toBe(null);
		const formatted = `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`.toLowerCase();
		expect(
			await Promise.all([
				consumePhonePairing(env.DB, pairing.id, formatted, NOW),
				consumePhonePairing(env.DB, pairing.id, formatted, NOW),
			]),
		).toStrictEqual([account.userId, null]);
	});
	it("cannot redeem after the authorizing desktop session is revoked", async () => {
		const account = await desktop();
		const pairing = await createPhonePairing(env.DB, account.sessionId, NOW);
		await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(account.sessionId).run();
		expect(await consumePhonePairing(env.DB, pairing.id, pairing.code, NOW)).toBe(null);
	});
});

describe("phone pairing account authentication", () => {
	it("requires a desktop session and the deployment origin", async () => {
		const account = await desktop();
		const anonymous = await worker.fetch(postAuthentication("phone-pairing/create", {}));
		const crossOrigin = postAuthentication("phone-pairing/create", {}, account.cookie);
		crossOrigin.headers.set("Origin", "https://attacker.example.com");
		const refused = await worker.fetch(crossOrigin);
		const noOrigin = postAuthentication("phone-pairing/create", {}, account.cookie);
		noOrigin.headers.delete("Origin");
		const missingOrigin = await worker.fetch(noOrigin);
		expect([anonymous.status, refused.status, missingOrigin.status]).toStrictEqual([401, 403, 403]);
	});
	it("issues an independent same-account session exactly once without returning its credential in JSON", async () => {
		const account = await desktop();
		const created = await worker.fetch(postAuthentication("phone-pairing/create", {}, account.cookie));
		expect([created.status, created.headers.get("Cache-Control")]).toStrictEqual([200, "no-store"]);
		const pairing = await created.json<{id: string; code: string; expiresAt: number}>();
		const body = {id: pairing.id, code: pairing.code};
		const crossOrigin = postAuthentication("phone-pairing/claim", body);
		crossOrigin.headers.set("Origin", "https://attacker.example.com");
		expect((await worker.fetch(crossOrigin)).status).toBe(403);
		const claimed = await worker.fetch(postAuthentication("phone-pairing/claim", body));
		expect({
			status: claimed.status,
			cache: claimed.headers.get("Cache-Control"),
			body: await claimed.json(),
		}).toStrictEqual({status: 200, cache: "no-store", body: {status: "ok"}});
		const phoneCookie = cookieFrom(claimed);
		expect(phoneCookie === account.cookie).toBe(false);
		const sessionResponse = await worker.fetch(`${API_ORIGIN}/api/auth/get-session`, {
			headers: {Cookie: phoneCookie},
		});
		const phone = await sessionResponse.json<{user: {id: string}; session: {id: string}}>();
		expect(phone.user.id).toBe(account.userId);
		expect(phone.session.id === account.sessionId).toBe(false);
		expect((await worker.fetch(postAuthentication("phone-pairing/claim", body))).status).toBe(400);
		expect(
			(await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`, {headers: {Cookie: phoneCookie}})).status,
		).toBe(200);
	});
});
