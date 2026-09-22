import {existsSync, readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const documentHead = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function linkHrefs(rel: string): string[] {
	return [...documentHead.matchAll(/<link\s+([^>]*)>/g)]
		.map((match) => match[1] ?? "")
		.filter((attributes) => attributes.includes(`rel="${rel}"`))
		.map((attributes) => /href="([^"]*)"/.exec(attributes)?.[1] ?? "");
}

describe("document head", () => {
	// 🖼️ Without a declared icon the browser asks for /favicon.ico, which the single-page fallback
	// answers with index.html, so the tab shows no icon while the installed app shows one.
	it("declares a browser-tab icon that exists in the published assets", () => {
		const icons = linkHrefs("icon");
		expect({
			icons,
			published: icons.map((href) => existsSync(new URL(`../public${href}`, import.meta.url))),
		}).toStrictEqual({
			icons: ["/icons/icon-192.png"],
			published: [true],
		});
	});
});
