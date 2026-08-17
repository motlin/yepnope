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
	const rendered: ReactNode[] = [];
	const lines = source.split(/\r?\n/);
	let textLines: string[] = [];
	let blockIndex = 0;

	function renderTextBlocks(): void {
		const firstContentLine = textLines.findIndex((line) => line.trim() !== "");
		if (firstContentLine === -1) {
			textLines = [];
			return;
		}
		let lastContentLine = textLines.length - 1;
		while (textLines[lastContentLine]?.trim() === "") {
			lastContentLine -= 1;
		}

		const blocks = textLines
			.slice(firstContentLine, lastContentLine + 1)
			.join("\n")
			.split(/\n{2,}/);
		for (const block of blocks) {
			const lines = block.split("\n");
			if (lines.every((line) => /^[-*] /.test(line))) {
				rendered.push(
					<ul key={blockIndex}>
						{lines.map((line, lineIndex) => (
							<li key={lineIndex}>{renderInline(line.slice(2), `${blockIndex}-${lineIndex}`)}</li>
						))}
					</ul>,
				);
				blockIndex += 1;
				continue;
			}
			rendered.push(<p key={blockIndex}>{renderParagraphLines(lines, String(blockIndex))}</p>);
			blockIndex += 1;
		}
		textLines = [];
	}

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		if (/^```[^`]*$/.test(lines[lineIndex] ?? "")) {
			const closingFenceIndex = lines.findIndex(
				(line, candidateIndex) => candidateIndex > lineIndex && /^```[\t ]*$/.test(line),
			);
			if (closingFenceIndex !== -1) {
				renderTextBlocks();
				rendered.push(
					<pre key={blockIndex}>
						<code>{lines.slice(lineIndex + 1, closingFenceIndex).join("\n")}</code>
					</pre>,
				);
				blockIndex += 1;
				lineIndex = closingFenceIndex;
				continue;
			}
		}
		textLines.push(lines[lineIndex] ?? "");
	}

	renderTextBlocks();
	return rendered;
}
