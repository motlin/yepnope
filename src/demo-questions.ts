import type {DeckQuestion} from "./deck";

export const DEMO_QUESTIONS: DeckQuestion[] = [
	{
		questionId: "demo:0",
		batchId: "demo",
		project: "Demo",
		repo: null,
		branch: null,
		directory: null,
		title: "Approve this sample change?",
		body: "This is a demo card. Swipe right or tap **Yep** to approve it.",
	},
	{
		questionId: "demo:1",
		batchId: "demo",
		project: "Demo",
		repo: null,
		branch: null,
		directory: null,
		title: "Reject this risky sample?",
		body: "Swipe left or tap **Nope** to reject this demo card.",
	},
	{
		questionId: "demo:2",
		batchId: "demo",
		project: "Demo",
		repo: null,
		branch: null,
		directory: null,
		title: "Skip this optional sample?",
		body: "Swipe down or tap **Skip** when you do not want to decide.",
	},
];

export function isDemoQuestion(questionId: string): boolean {
	return DEMO_QUESTIONS.some((question) => question.questionId === questionId);
}
