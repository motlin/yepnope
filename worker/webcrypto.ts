// 🔐 Cryptographic byte and hash helpers shared by authentication and web push.

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(encoded: string): Uint8Array {
	const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

export function asKeyPair(key: CryptoKey | CryptoKeyPair): CryptoKeyPair {
	if (!("privateKey" in key)) {
		throw new Error("expected an EC key pair");
	}
	return key;
}

export function asArrayBuffer(exported: ArrayBuffer | JsonWebKey): ArrayBuffer {
	if (!(exported instanceof ArrayBuffer)) {
		throw new Error("expected raw key bytes");
	}
	return exported;
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
