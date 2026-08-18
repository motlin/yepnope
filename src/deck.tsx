import {useEffect, useRef, useState, type ReactElement} from "react";
import {renderMarkdown} from "./markdown";

// 🃏 The card deck, ported from mockups/index.html (variant 2, "chips on card"):
// drag with YEP/NOPE/SKIP stamps, right yep, left nope, down skip, spring-back
// under threshold, buttons, and arrow keys for desktop. Skip is terminal (spec §7.5).

export type Disposition = "yep" | "nope" | "skip";

export interface DeckQuestion {
	questionId: string;
	batchId: string;
	project: string;
	// 🧭 Card chips (variant 2 in .llm/decisions.md): shim-derived, null for
	// hook-sourced and non-git batches.
	repo: string | null;
	branch: string | null;
	directory: string | null;
	title: string;
	body: string;
}

export interface DeckProps {
	questions: DeckQuestion[];
	onAnswer: (questionId: string, disposition: Disposition) => void;
}

export const FLY_OUT_MILLISECONDS = 300;
const COMMIT_X = 100;
const COMMIT_Y = 110;

const FLY_TRANSFORMS: Record<Disposition, string> = {
	yep: "translate(600px, -40px) rotate(20deg)",
	nope: "translate(-600px, -40px) rotate(-20deg)",
	skip: "translate(0, 700px) rotate(4deg)",
};

const ARROW_KEYS: Record<string, Disposition> = {
	ArrowRight: "yep",
	ArrowLeft: "nope",
	ArrowDown: "skip",
};

interface DragState {
	startX: number;
	startY: number;
	dx: number;
	dy: number;
}

function isVerticalDrag(dx: number, dy: number): boolean {
	return dy > 0 && dy > Math.abs(dx);
}

// Null means the drag never reached a commit threshold, so the card springs back.
function dispositionForDrag(dx: number, dy: number): Disposition | null {
	if (isVerticalDrag(dx, dy)) {
		return dy > COMMIT_Y ? "skip" : null;
	}
	if (dx > COMMIT_X) {
		return "yep";
	}
	if (dx < -COMMIT_X) {
		return "nope";
	}
	return null;
}

function stampOpacities(drag: DragState | null, flying: Disposition | null): Record<Disposition, number> {
	if (flying !== null) {
		return {yep: flying === "yep" ? 1 : 0, nope: flying === "nope" ? 1 : 0, skip: flying === "skip" ? 1 : 0};
	}
	if (drag === null) {
		return {yep: 0, nope: 0, skip: 0};
	}
	const vertical = isVerticalDrag(drag.dx, drag.dy);
	return {
		yep: !vertical && drag.dx > 0 ? Math.min(1, drag.dx / 80) : 0,
		nope: !vertical && drag.dx < 0 ? Math.min(1, -drag.dx / 80) : 0,
		skip: vertical ? Math.min(1, drag.dy / 90) : 0,
	};
}

interface CardChipsProps {
	card: DeckQuestion;
}

function CardChips({card}: CardChipsProps): ReactElement | null {
	const chips = [
		{field: "repo", value: card.repo},
		{field: "branch", value: card.branch},
		{field: "directory", value: card.directory},
	].filter((chip) => chip.value !== null);
	if (chips.length === 0) {
		return null;
	}
	return (
		<div className="chip-row">
			{chips.map((chip) => (
				<span key={chip.field} className="chip">
					{chip.value}
				</span>
			))}
		</div>
	);
}

export function Deck({questions, onAnswer}: DeckProps): ReactElement {
	const [drag, setDrag] = useState<DragState | null>(null);
	const [flying, setFlying] = useState<Disposition | null>(null);
	const [springing, setSpringing] = useState(false);
	const [answeredCount, setAnsweredCount] = useState(0);
	const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const card = questions[0];
	const cardId = card?.questionId;

	useEffect(() => {
		return () => {
			if (flyTimer.current !== null) {
				clearTimeout(flyTimer.current);
			}
		};
	}, []);

	function commit(disposition: Disposition): void {
		if (cardId === undefined || flying !== null) {
			return;
		}
		setFlying(disposition);
		setSpringing(false);
		flyTimer.current = setTimeout(() => {
			flyTimer.current = null;
			setFlying(null);
			setDrag(null);
			setAnsweredCount((count) => count + 1);
			onAnswer(cardId, disposition);
		}, FLY_OUT_MILLISECONDS);
	}

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			const disposition = ARROW_KEYS[event.key];
			if (disposition === undefined) {
				return;
			}
			event.preventDefault();
			commit(disposition);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- commit is stable per (cardId, flying) render
	}, [cardId, flying]);

	if (card === undefined) {
		return (
			<div className="deck">
				<div className="resolved">
					<h3>All caught up</h3>
					<p>Your question queue is empty. New questions will appear here when they arrive.</p>
				</div>
			</div>
		);
	}

	const stamps = stampOpacities(drag, flying);
	const classNames = ["card"];
	let transform = "";
	if (flying !== null) {
		transform = FLY_TRANSFORMS[flying];
		classNames.push("flying");
	} else if (drag !== null) {
		transform = `translate(${drag.dx}px, ${drag.dy}px) rotate(${drag.dx * 0.05}deg)`;
		classNames.push("dragging");
	}
	if (springing) {
		classNames.push("springing");
	}
	const cardClass = classNames.join(" ");

	return (
		<>
			<div className="deck-header">
				<span className="project">{card.project}</span>
				<span className="count">{`${answeredCount + 1} of ${answeredCount + questions.length}`}</span>
			</div>
			<div className="deck">
				<div className="card-behind" style={{visibility: questions.length > 1 ? "visible" : "hidden"}} />
				<div
					className={cardClass}
					style={{transform}}
					onPointerDown={(event) => {
						if (flying !== null) {
							return;
						}
						event.currentTarget.setPointerCapture(event.pointerId);
						setSpringing(false);
						setDrag({startX: event.clientX, startY: event.clientY, dx: 0, dy: 0});
					}}
					onPointerMove={(event) => {
						if (drag === null || flying !== null) {
							return;
						}
						setDrag({...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY});
					}}
					onPointerUp={() => {
						if (drag === null || flying !== null) {
							return;
						}
						const disposition = dispositionForDrag(drag.dx, drag.dy);
						if (disposition === null) {
							setDrag(null);
							setSpringing(true);
							return;
						}
						commit(disposition);
					}}
				>
					<CardChips card={card} />
					<h2 className="title">{card.title}</h2>
					<div className="body">{renderMarkdown(card.body)}</div>
					<div className="stamp yep" style={{opacity: stamps.yep}}>
						YEP
					</div>
					<div className="stamp nope" style={{opacity: stamps.nope}}>
						NOPE
					</div>
					<div className="stamp skip" style={{opacity: stamps.skip}}>
						SKIP
					</div>
				</div>
			</div>
			<div className="actions">
				<button
					type="button"
					className="btn-nope"
					onClick={() => {
						commit("nope");
					}}
				>
					&larr; Nope
				</button>
				<button
					type="button"
					className="btn-skip"
					onClick={() => {
						commit("skip");
					}}
				>
					&darr; Skip
				</button>
				<button
					type="button"
					className="btn-yep"
					onClick={() => {
						commit("yep");
					}}
				>
					Yep &rarr;
				</button>
			</div>
		</>
	);
}
