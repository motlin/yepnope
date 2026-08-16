import type {ReactNode} from "react";

// 📝 The MVP markdown subset (spec §17): bold, code, lists, paragraphs. Nothing else.

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
	return text.split(INLINE_PATTERN).map((part, index) => {
		const key = `${keyPrefix}-${index}`;
		if (part.startsWith("**") && part.endsWith("**")) {
			return <b key={key}>{part.slice(2, -2)}</b>;
		}
		if (part.startsWith("`") && part.endsWith("`")) {
			return <code key={key}>{part.slice(1, -1)}</code>;
		}
		return part;
	});
}

function renderParagraphLines(lines: string[], keyPrefix: string): ReactNode[] {
	return lines.flatMap((line, index) => {
		const rendered = renderInline(line, `${keyPrefix}-${index}`);
		return index === 0 ? rendered : [<br key={`${keyPrefix}-break-${index}`} />, ...rendered];
	});
}

export function renderMarkdown(source: string): ReactNode[] {
	return source
		.split(/\n{2,}/)
		.filter((block) => block.trim() !== "")
		.map((block, blockIndex) => {
			const lines = block.split("\n");
			if (lines.every((line) => /^[-*] /.test(line))) {
				return (
					<ul key={blockIndex}>
						{lines.map((line, lineIndex) => (
							<li key={lineIndex}>{renderInline(line.slice(2), `${blockIndex}-${lineIndex}`)}</li>
						))}
					</ul>
				);
			}
			return <p key={blockIndex}>{renderParagraphLines(lines, String(blockIndex))}</p>;
		});
}
