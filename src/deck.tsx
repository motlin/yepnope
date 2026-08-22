import {useCallback, useEffect, useRef, useState, type ReactElement} from "react";
import {renderMarkdown} from "./markdown";

// 🃏 The card deck, ported from mockups/index.html (variant 2, "chips on card"):
// drag with YEP/NOPE/SKIP stamps, right yep, left nope, down skip, spring-back
// under threshold, buttons, and arrow keys for desktop. Skip is terminal (spec §7.5).
//
// ↩️ Every swipe is held for UNDO_WINDOW_MILLISECONDS before it reaches onAnswer, so a
// mis-swipe can be taken back. The hold lives here rather than on the server: the blocking
// ask_yep_nope call is released by the answer POST, so never sending it is simpler than
// retracting it afterwards, and the last card of a batch waits out the window like the rest.

export type Disposition = "yep" | "nope" | "skip";

export interface DeckQuestion {
	questionId: string;
	batchId: string;
	project: string;
	// 🧭 Card chips (variant 2 in .llm/decisions.md): caller-derived, null for
	// hook-sourced and non-git batches.
	repo: string | null;
	branch: string | null;
	worktree: string | null;
	directory: string | null;
	title: string;
	body: string;
}

export interface DeckProps {
	questions: DeckQuestion[];
	onAnswer: (questionId: string, disposition: Disposition) => void;
}

export const FLY_OUT_MILLISECONDS = 300;
export const UNDO_WINDOW_MILLISECONDS = 5000;
const UNDO_TICK_MILLISECONDS = 250;
const COMMIT_X = 100;
const COMMIT_Y = 110;

const DISPOSITION_LABELS: Record<Disposition, string> = {
	yep: "Yep",
	nope: "Nope",
	skip: "Skip",
};

const UNDO_KEY = "u";

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
	pointerId: number;
	startX: number;
	startY: number;
	dx: number;
	dy: number;
}

// A swipe that has left the deck but has not reached the parent yet.
interface HeldAnswer {
	questionId: string;
	disposition: Disposition;
	deadline: number;
}

function secondsLeft(deadline: number): number {
	return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
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
		{field: "worktree", value: card.worktree},
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
	const [held, setHeld] = useState<HeldAnswer | null>(null);
	const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
	const [submittedIds, setSubmittedIds] = useState<string[]>([]);
	const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const heldRef = useRef<HeldAnswer | null>(null);
	const onAnswerRef = useRef(onAnswer);
	// 🤏 Pinch-zoom puts a second finger on the card; only a lone finger is a swipe.
	const activePointerIds = useRef(new Set<number>());

	useEffect(() => {
		onAnswerRef.current = onAnswer;
	});

	// The parent keeps a question until its answer lands, so hide the ones already sent.
	const hidden = new Set(submittedIds);
	if (held !== null) {
		hidden.add(held.questionId);
	}
	const pendingQuestions = questions.filter((question) => !hidden.has(question.questionId));
	const card = pendingQuestions[0];
	const cardId = card?.questionId;

	useEffect(() => {
		setSubmittedIds((ids) => {
			const stillListed = ids.filter((id) => questions.some((question) => question.questionId === id));
			return stillListed.length === ids.length ? ids : stillListed;
		});
	}, [questions]);

	const submit = useCallback((answer: HeldAnswer): void => {
		// Identity check: an undone or already-submitted answer is no longer the held one.
		if (heldRef.current !== answer) {
			return;
		}
		heldRef.current = null;
		setHeld(null);
		setSubmittedIds((ids) => [...ids, answer.questionId]);
		onAnswerRef.current(answer.questionId, answer.disposition);
	}, []);

	const undo = useCallback((): void => {
		const answer = heldRef.current;
		if (answer === null) {
			return;
		}
		heldRef.current = null;
		setHeld(null);
		setAnsweredCount((count) => count - 1);
	}, []);

	useEffect(() => {
		if (held === null) {
			return undefined;
		}
		const ticker = setInterval(() => {
			if (held.deadline - Date.now() <= 0) {
				submit(held);
				return;
			}
			setUndoSecondsLeft(secondsLeft(held.deadline));
		}, UNDO_TICK_MILLISECONDS);
		return () => {
			clearInterval(ticker);
		};
	}, [held, submit]);

	useEffect(() => {
		return () => {
			if (flyTimer.current !== null) {
				clearTimeout(flyTimer.current);
			}
			// Leaving the deck ends the window early rather than dropping the swipe.
			const answer = heldRef.current;
			if (answer !== null) {
				heldRef.current = null;
				onAnswerRef.current(answer.questionId, answer.disposition);
			}
		};
	}, []);

	function hold(questionId: string, disposition: Disposition): void {
		const previous = heldRef.current;
		if (previous !== null) {
			submit(previous);
		}
		const answer: HeldAnswer = {questionId, disposition, deadline: Date.now() + UNDO_WINDOW_MILLISECONDS};
		heldRef.current = answer;
		setHeld(answer);
		setUndoSecondsLeft(secondsLeft(answer.deadline));
	}

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
			hold(cardId, disposition);
		}, FLY_OUT_MILLISECONDS);
	}

	function abandonDrag(): void {
		setSpringing(drag !== null);
		setDrag(null);
	}

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			// Bare "u" only: Cmd+U and friends belong to the browser.
			if (event.key.toLowerCase() === UNDO_KEY && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault();
				undo();
				return;
			}
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
	}, [cardId, flying, undo]);

	const undoBar =
		held === null ? null : (
			<div className="undo-bar">
				<span className="undo-message">
					{/* Only the disposition is announced: a live countdown would repeat every second. */}
					<span className={`undo-disposition ${held.disposition}`} role="status">
						{`${DISPOSITION_LABELS[held.disposition]} recorded`}
					</span>
					<span className="undo-countdown">{`${undoSecondsLeft}s to undo`}</span>
				</span>
				<button
					type="button"
					className="undo-button"
					aria-keyshortcuts="U"
					aria-label={`Undo ${DISPOSITION_LABELS[held.disposition].toLowerCase()}`}
					onClick={undo}
				>
					Undo
				</button>
			</div>
		);

	if (card === undefined) {
		return (
			<>
				<div className="deck">
					<div className="resolved">
						<h3>All caught up</h3>
						<p>Your question queue is empty. New questions will appear here when they arrive.</p>
					</div>
				</div>
				{undoBar}
			</>
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
				<span className="count">{`${answeredCount + 1} of ${answeredCount + pendingQuestions.length}`}</span>
			</div>
			<div className="deck">
				<div className="card-behind" style={{visibility: pendingQuestions.length > 1 ? "visible" : "hidden"}} />
				<div
					className={cardClass}
					style={{transform}}
					onPointerDown={(event) => {
						// Tracked even mid-flight, so a finger held across the animation still counts.
						activePointerIds.current.add(event.pointerId);
						if (flying !== null) {
							return;
						}
						if (activePointerIds.current.size > 1) {
							abandonDrag();
							return;
						}
						event.currentTarget.setPointerCapture(event.pointerId);
						setSpringing(false);
						setDrag({
							pointerId: event.pointerId,
							startX: event.clientX,
							startY: event.clientY,
							dx: 0,
							dy: 0,
						});
					}}
					onPointerMove={(event) => {
						if (drag === null || flying !== null || event.pointerId !== drag.pointerId) {
							return;
						}
						setDrag({...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY});
					}}
					onPointerUp={(event) => {
						activePointerIds.current.delete(event.pointerId);
						if (drag === null || flying !== null || event.pointerId !== drag.pointerId) {
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
					onPointerCancel={(event) => {
						activePointerIds.current.delete(event.pointerId);
						if (drag !== null && event.pointerId === drag.pointerId) {
							abandonDrag();
						}
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
			{undoBar}
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
