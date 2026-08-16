// Generates the PWA icon set in public/icons: a card silhouette with the YEP stamp,
// drawn per-pixel and encoded as PNG with zlib only. Rerun: node scripts/generate-icons.mjs
import {deflateSync} from "node:zlib";
import {writeFileSync, mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const CRC_TABLE = new Int32Array(256).map((_unused, n) => {
	let c = n;
	for (let k = 0; k < 8; k += 1) {
		c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return c;
});

function crc32(bytes) {
	let crc = -1;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y += 1) {
		raw[y * (size * 4 + 1)] = 0; // filter none
		pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, {level: 9})),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function roundedRectDistance(x, y, cx, cy, halfWidth, halfHeight, radius) {
	const qx = Math.abs(x - cx) - (halfWidth - radius);
	const qy = Math.abs(y - cy) - (halfHeight - radius);
	const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
	return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function coverage(distance) {
	return Math.min(1, Math.max(0, 0.5 - distance));
}

function blend(pixels, index, r, g, b, alpha) {
	if (alpha <= 0) {
		return;
	}
	const existingAlpha = pixels[index + 3] / 255;
	const outAlpha = alpha + existingAlpha * (1 - alpha);
	pixels[index] = Math.round((r * alpha + pixels[index] * existingAlpha * (1 - alpha)) / outAlpha);
	pixels[index + 1] = Math.round((g * alpha + pixels[index + 1] * existingAlpha * (1 - alpha)) / outAlpha);
	pixels[index + 2] = Math.round((b * alpha + pixels[index + 2] * existingAlpha * (1 - alpha)) / outAlpha);
	pixels[index + 3] = Math.round(outAlpha * 255);
}

function drawIcon(size, background) {
	const pixels = Buffer.alloc(size * size * 4);
	const center = size / 2;
	const stampAngle = (-12 * Math.PI) / 180;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const index = (y * size + x) * 4;
			pixels[index] = background[0];
			pixels[index + 1] = background[1];
			pixels[index + 2] = background[2];
			pixels[index + 3] = 255;
			// White card, slightly portrait.
			const card = roundedRectDistance(x, y, center, center, size * 0.29, size * 0.36, size * 0.07);
			blend(pixels, index, 0xff, 0xff, 0xff, coverage(card));
			// Green stamp border, rotated like the YEP stamp.
			const rx = center + (x - center) * Math.cos(stampAngle) - (y - center) * Math.sin(stampAngle);
			const ry = center + (x - center) * Math.sin(stampAngle) + (y - center) * Math.cos(stampAngle);
			const stamp = Math.abs(roundedRectDistance(rx, ry, center, center, size * 0.21, size * 0.1, size * 0.035));
			blend(pixels, index, 0x2e, 0xb8, 0x72, coverage(stamp - size * 0.022));
		}
	}
	return encodePng(size, pixels);
}

function drawBadge(size) {
	// Monochrome for the Android notification badge: white card outline on transparency.
	const pixels = Buffer.alloc(size * size * 4);
	const center = size / 2;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const index = (y * size + x) * 4;
			const outline = Math.abs(roundedRectDistance(x, y, center, center, size * 0.3, size * 0.38, size * 0.08));
			blend(pixels, index, 0xff, 0xff, 0xff, coverage(outline - size * 0.05));
		}
	}
	return encodePng(size, pixels);
}

mkdirSync(OUT_DIR, {recursive: true});
const BACKGROUND = [0x17, 0x18, 0x1c];
writeFileSync(join(OUT_DIR, "icon-192.png"), drawIcon(192, BACKGROUND));
writeFileSync(join(OUT_DIR, "icon-512.png"), drawIcon(512, BACKGROUND));
writeFileSync(join(OUT_DIR, "apple-touch-icon.png"), drawIcon(180, BACKGROUND));
writeFileSync(join(OUT_DIR, "badge-96.png"), drawBadge(96));
console.log("icons written to", OUT_DIR);
