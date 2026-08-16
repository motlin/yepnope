// @vitest-environment jsdom
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {renderMarkdown} from "../src/markdown";

function html(source: string): string {
	const {container} = render(<div>{renderMarkdown(source)}</div>);
	return container.innerHTML;
}

describe("renderMarkdown", () => {
	it("wraps plain text in a paragraph", () => {
		expect(html("Just a sentence.")).toBe("<div><p>Just a sentence.</p></div>");
	});

	it("renders **bold** spans", () => {
		expect(html("The **billing service** lock.")).toBe("<div><p>The <b>billing service</b> lock.</p></div>");
	});

	it("renders `code` spans", () => {
		expect(html("Rename `PaymentRetry` now.")).toBe("<div><p>Rename <code>PaymentRetry</code> now.</p></div>");
	});

	it("renders dash lists as ul/li with inline markup", () => {
		expect(html("- first `item`\n- **second**")).toBe(
			"<div><ul><li>first <code>item</code></li><li><b>second</b></li></ul></div>",
		);
	});

	it("splits blank-line separated blocks into paragraphs", () => {
		expect(html("one\n\ntwo")).toBe("<div><p>one</p><p>two</p></div>");
	});

	it("keeps single newlines as line breaks inside a paragraph", () => {
		expect(html("one\ntwo")).toBe("<div><p>one<br>two</p></div>");
	});

	it("escapes HTML rather than injecting it", () => {
		expect(html("<script>alert(1)</script>")).toBe("<div><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>");
	});
});
