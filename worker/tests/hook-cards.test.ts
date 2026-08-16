import {describe, expect, it} from "vitest";
import {buildPermissionCard} from "../hook-cards";
import {BODY_MAX_CHARACTERS, TITLE_MAX_CHARACTERS} from "../validation";

describe("buildPermissionCard", () => {
	it("builds a yes-biased card from a Bash command", () => {
		const card = buildPermissionCard(
			"Bash",
			{command: "git push origin main", description: "Push the branch"},
			"/Users/craig/projects/yepnope",
		);
		expect(card.project).toBe("yepnope");
		expect(card.title).toBe("Allow Bash: git push origin main?");
		expect(card.body).toContain("Push the branch");
		expect(card.body).toContain("```\ngit push origin main\n```");
		expect(card.body).toContain("permission");
	});

	it("keeps only the first line of a multi-line command in the title", () => {
		const card = buildPermissionCard("Bash", {command: "echo one\necho two"}, "/repo");
		expect(card.title).toBe("Allow Bash: echo one?");
		expect(card.body).toContain("echo one\necho two");
	});

	it("truncates a huge command to the title and body limits", () => {
		const command = "x".repeat(5000);
		const card = buildPermissionCard("Bash", {command}, "/repo");
		expect(card.title.length).toBe(TITLE_MAX_CHARACTERS);
		expect(card.title.endsWith("…")).toBe(true);
		expect(card.body.length).toBeLessThanOrEqual(BODY_MAX_CHARACTERS);
		expect(card.body).toContain("…");
	});

	it("uses file_path when there is no command", () => {
		const card = buildPermissionCard(
			"Edit",
			{file_path: "/repo/src/index.ts", old_string: "a", new_string: "b"},
			"/repo",
		);
		expect(card.title).toBe("Allow Edit: /repo/src/index.ts?");
	});

	it("falls back to compact JSON for other tool input", () => {
		const card = buildPermissionCard("WebFetch", {url: "https://example.com"}, "/repo");
		expect(card.title).toBe('Allow WebFetch: {"url":"https://example.com"}?');
		expect(card.body).toContain('{"url":"https://example.com"}');
	});

	it("handles empty input and a missing cwd", () => {
		const card = buildPermissionCard("SomeTool", {}, undefined);
		expect(card.title).toBe("Allow SomeTool?");
		expect(card.project).toBe("permission");
	});

	it("never exceeds the shared limits even with a huge description", () => {
		const card = buildPermissionCard("Bash", {command: "true", description: "d".repeat(2000)}, "/repo");
		expect(card.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARACTERS);
		expect(card.body.length).toBeLessThanOrEqual(BODY_MAX_CHARACTERS);
	});

	it("keeps the command on the card even when the tool name is absurd", () => {
		const card = buildPermissionCard("T".repeat(5000), {command: "true"}, "/repo");
		expect(card.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARACTERS);
		expect(card.body.length).toBeLessThanOrEqual(BODY_MAX_CHARACTERS);
		expect(card.body).toContain("```\ntrue\n```");
	});
});
