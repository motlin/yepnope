import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {base64UrlDecode} from "../webcrypto";
import {buildPushRequest, vapidPublicKeyFromJwk} from "../webpush";
import {createPushReceiver} from "./push-helpers";
import {required} from "./helpers";

const ENDPOINT = "https://push.example.com/send/abc123";

function vapidPrivateJwk(): JsonWebKey {
	return JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
}

describe("vapidPublicKeyFromJwk", () => {
	it("returns the 65 byte uncompressed point, base64url encoded", () => {
		const encoded = vapidPublicKeyFromJwk(vapidPrivateJwk());
		const raw = base64UrlDecode(encoded);
		expect(raw).toHaveLength(65);
		expect(raw[0]).toBe(4);
	});
});

describe("buildPushRequest", () => {
	it("targets the subscription endpoint with aes128gcm headers", async () => {
		const receiver = await createPushReceiver(ENDPOINT);
		const request = await buildPushRequest({
			subscription: receiver.subscription,
			payload: JSON.stringify({batch_id: "b1", count: 2}),
			vapidPrivateJwk: vapidPrivateJwk(),
			vapidSubject: env.VAPID_SUBJECT,
		});
		expect(request.endpoint).toBe(ENDPOINT);
		expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
		expect(request.headers["TTL"]).toBe("86400");
		expect(request.headers["Urgency"]).toBe("high");
	});

	it("encrypts the payload so only the subscription keys can read it", async () => {
		const receiver = await createPushReceiver(ENDPOINT);
		const payload = JSON.stringify({batch_id: "b2", project: "demo", count: 12});
		const request = await buildPushRequest({
			subscription: receiver.subscription,
			payload,
			vapidPrivateJwk: vapidPrivateJwk(),
			vapidSubject: env.VAPID_SUBJECT,
		});
		expect(await receiver.decrypt(request.body)).toBe(payload);
	});

	it("signs a VAPID JWT for the push service origin", async () => {
		const receiver = await createPushReceiver(ENDPOINT);
		const request = await buildPushRequest({
			subscription: receiver.subscription,
			payload: "{}",
			vapidPrivateJwk: vapidPrivateJwk(),
			vapidSubject: env.VAPID_SUBJECT,
		});
		const authorization = required(request.headers["Authorization"], "Authorization header");
		const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
		const token = required(match?.[1], "vapid token");
		const publicKey = required(match?.[2], "vapid public key");
		expect(publicKey).toBe(vapidPublicKeyFromJwk(vapidPrivateJwk()));

		const [headerPart, claimsPart, signaturePart] = token.split(".");
		const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(required(headerPart, "jwt header"))));
		expect(header).toEqual({typ: "JWT", alg: "ES256"});

		const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(required(claimsPart, "jwt claims"))));
		expect(claims.aud).toBe("https://push.example.com");
		expect(claims.sub).toBe(env.VAPID_SUBJECT);
		expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
		expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 60 * 60);

		const {d: _d, key_ops: _keyOps, ...publicJwk} = vapidPrivateJwk();
		const verifyKey = await crypto.subtle.importKey(
			"jwk",
			{...publicJwk, key_ops: ["verify"]},
			{name: "ECDSA", namedCurve: "P-256"},
			false,
			["verify"],
		);
		const verified = await crypto.subtle.verify(
			{name: "ECDSA", hash: "SHA-256"},
			verifyKey,
			base64UrlDecode(required(signaturePart, "jwt signature")),
			new TextEncoder().encode(`${headerPart}.${claimsPart}`),
		);
		expect(verified).toBe(true);
	});
});
