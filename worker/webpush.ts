import {z} from "zod";
import {asArrayBuffer, asKeyPair, base64UrlDecode, base64UrlEncode, concatBytes} from "./webcrypto";

// 🔐 Web push per RFC 8291 (aes128gcm) and RFC 8292 (VAPID): WebCrypto only, no push vendor (spec §6.1).

export interface PushSubscription {
	endpoint: string;
	keys: {p256dh: string; auth: string};
}

export interface PushRequest {
	endpoint: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

const RECORD_SIZE = 4096;
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

const vapidJwkSchema = z.object({
	kty: z.literal("EC"),
	crv: z.literal("P-256"),
	x: z.string().min(1),
	y: z.string().min(1),
	d: z.string().min(1),
});

export function parseVapidJwk(json: string): JsonWebKey {
	const parsed = vapidJwkSchema.parse(JSON.parse(json));
	return {kty: parsed.kty, crv: parsed.crv, x: parsed.x, y: parsed.y, d: parsed.d};
}

function requireField(value: string | undefined, label: string): string {
	if (value === undefined) {
		throw new Error(`VAPID JWK is missing ${label}`);
	}
	return value;
}

export function vapidPublicKeyFromJwk(jwk: JsonWebKey): string {
	const x = base64UrlDecode(requireField(jwk.x, "x"));
	const y = base64UrlDecode(requireField(jwk.y, "y"));
	return base64UrlEncode(concatBytes(Uint8Array.of(4), x, y));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const derived = await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, key, bytes * 8);
	return new Uint8Array(derived);
}

async function signVapidJwt(audience: string, subject: string, privateJwk: JsonWebKey): Promise<string> {
	const encoder = new TextEncoder();
	const header = base64UrlEncode(encoder.encode(JSON.stringify({typ: "JWT", alg: "ES256"})));
	const claims = base64UrlEncode(
		encoder.encode(
			JSON.stringify({
				aud: audience,
				exp: Math.floor(Date.now() / 1000) + VAPID_JWT_LIFETIME_SECONDS,
				sub: subject,
			}),
		),
	);
	const signingKey = await crypto.subtle.importKey("jwk", privateJwk, {name: "ECDSA", namedCurve: "P-256"}, false, [
		"sign",
	]);
	// ✍️ WebCrypto ECDSA emits the raw r||s form JWS wants; no DER conversion needed.
	const signature = await crypto.subtle.sign(
		{name: "ECDSA", hash: "SHA-256"},
		signingKey,
		encoder.encode(`${header}.${claims}`),
	);
	return `${header}.${claims}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// 🔒 RFC 8291: ECDH against the subscription's p256dh key, HKDF chain, single aes128gcm record.
async function encryptPayload(subscription: PushSubscription, plaintext: Uint8Array): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const receiverPublicBytes = base64UrlDecode(subscription.keys.p256dh);
	const authSecret = base64UrlDecode(subscription.keys.auth);

	const senderPair = asKeyPair(
		await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]),
	);
	const senderPublic = new Uint8Array(asArrayBuffer(await crypto.subtle.exportKey("raw", senderPair.publicKey)));
	const receiverKey = await crypto.subtle.importKey(
		"raw",
		receiverPublicBytes,
		{name: "ECDH", namedCurve: "P-256"},
		false,
		[],
	);
	// The workerd type declares this field as `$public`, but the runtime reads `public`;
	// a non-literal sidesteps the excess property check without an unsafe assertion.
	const ecdhParams = {name: "ECDH", public: receiverKey};
	const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, senderPair.privateKey, 256));

	const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), receiverPublicBytes, senderPublic);
	const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const contentKey = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: nonce\0"), 12);

	const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
	// 📦 One record: plaintext, then the 0x02 last-record padding delimiter.
	const record = concatBytes(plaintext, Uint8Array.of(2));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, aesKey, record));

	const headerBlock = new Uint8Array(16 + 4 + 1 + senderPublic.length);
	headerBlock.set(salt, 0);
	new DataView(headerBlock.buffer).setUint32(16, RECORD_SIZE);
	headerBlock[20] = senderPublic.length;
	headerBlock.set(senderPublic, 21);
	return concatBytes(headerBlock, ciphertext);
}

export interface BuildPushRequestOptions {
	subscription: PushSubscription;
	payload: string;
	vapidPrivateJwk: JsonWebKey;
	vapidSubject: string;
}

export async function buildPushRequest(options: BuildPushRequestOptions): Promise<PushRequest> {
	const audience = new URL(options.subscription.endpoint).origin;
	const jwt = await signVapidJwt(audience, options.vapidSubject, options.vapidPrivateJwk);
	const body = await encryptPayload(options.subscription, new TextEncoder().encode(options.payload));
	return {
		endpoint: options.subscription.endpoint,
		headers: {
			Authorization: `vapid t=${jwt}, k=${vapidPublicKeyFromJwk(options.vapidPrivateJwk)}`,
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: "86400",
			Urgency: "high",
		},
		body,
	};
}
