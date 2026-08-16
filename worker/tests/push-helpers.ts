import {asArrayBuffer, asKeyPair, base64UrlEncode, concatBytes} from "../webcrypto";

// 🧪 Simulates the browser side of RFC 8291: holds the subscription keys and decrypts push bodies.
// The HKDF chain stays local so the receiver derives its keys independently of the sender.

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const derived = await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, key, bytes * 8);
	return new Uint8Array(derived);
}

export interface PushReceiver {
	subscription: {endpoint: string; keys: {p256dh: string; auth: string}};
	decrypt(body: Uint8Array): Promise<string>;
}

export async function createPushReceiver(endpoint: string): Promise<PushReceiver> {
	const pair = asKeyPair(await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]));
	const uaPublic = new Uint8Array(asArrayBuffer(await crypto.subtle.exportKey("raw", pair.publicKey)));
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	const encoder = new TextEncoder();

	return {
		subscription: {
			endpoint,
			keys: {p256dh: base64UrlEncode(uaPublic), auth: base64UrlEncode(authSecret)},
		},
		async decrypt(body: Uint8Array): Promise<string> {
			const salt = body.slice(0, 16);
			const keyLength = body[20];
			if (keyLength !== 65) {
				throw new Error(`expected a 65 byte sender key, got ${keyLength}`);
			}
			const senderPublic = body.slice(21, 21 + keyLength);
			const ciphertext = body.slice(21 + keyLength);

			const senderKey = await crypto.subtle.importKey(
				"raw",
				senderPublic,
				{name: "ECDH", namedCurve: "P-256"},
				false,
				[],
			);
			const ecdhParams = {name: "ECDH", public: senderKey};
			const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, pair.privateKey, 256));
			const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), uaPublic, senderPublic);
			const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);
			const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
			const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

			const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
			const record = new Uint8Array(
				await crypto.subtle.decrypt({name: "AES-GCM", iv: nonce}, aesKey, ciphertext),
			);
			let end = record.length - 1;
			while (end >= 0 && record[end] === 0) {
				end -= 1;
			}
			if (record[end] !== 2) {
				throw new Error("missing 0x02 last-record padding delimiter");
			}
			return new TextDecoder().decode(record.slice(0, end));
		},
	};
}
