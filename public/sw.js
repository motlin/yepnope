// 📣 Push pipeline (spec §6): one private notification per batch. Question content
// is fetched after receipt and shown only where notification actions can answer it.
"use strict";

self.addEventListener("install", () => {
	void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

async function setBadge(outstanding) {
	if ("setAppBadge" in navigator) {
		if (outstanding > 0) {
			await navigator.setAppBadge(outstanding);
		} else {
			await navigator.clearAppBadge();
		}
	}
}

self.addEventListener("push", (event) => {
	const payload = event.data ? event.data.json() : {};
	event.waitUntil(showBatchNotification(payload));
});

function genericTitle(count, project) {
	return `${count} ${count === 1 ? "question" : "questions"} from ${project}`;
}

function supportsNotificationActions() {
	const userAgent = navigator.userAgent;
	const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
	const android = /Android/.test(userAgent);
	const desktop = !/Android|Mobile|iPhone|iPad|iPod/.test(userAgent);
	return !ios && (android || desktop) && (self.Notification?.maxActions || 0) >= 2;
}

async function fetchBatchQuestion(batchId) {
	const response = await fetch("/api/v1/current-deck", {credentials: "same-origin"});
	if (!response.ok) {
		throw new Error(`question fetch failed with ${response.status}`);
	}
	const body = await response.json();
	if (!body || !Array.isArray(body.current_deck)) {
		throw new Error("question fetch returned an invalid response");
	}
	const matches = body.current_deck.filter((question) => question.batch_id === batchId);
	if (matches.length !== 1 || typeof matches[0].question_id !== "string" || typeof matches[0].title !== "string") {
		return null;
	}
	return matches[0];
}

async function showBatchNotification(payload) {
	const count = payload.count || 0;
	const project = payload.project || "your agent";
	const question = await fetchBatchQuestion(payload.batch_id).catch(() => null);
	const detailed = count === 1 && question !== null && supportsNotificationActions();
	const title = detailed ? question.title : genericTitle(count, project);
	const options = {
		body: detailed ? project : "Open to swipe.",
		tag: payload.batch_id,
		data: detailed ? {...payload, question_id: question.question_id} : payload,
		icon: "/icons/icon-192.png",
		badge: "/icons/badge-96.png",
	};
	if (detailed) {
		options.actions = [
			{action: "yep", title: "Yep"},
			{action: "nope", title: "Nope"},
		];
	}
	await Promise.all([self.registration.showNotification(title, options), setBadge(payload.outstanding || count)]);
}

async function refreshOpenClients() {
	const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
	for (const client of windows) {
		client.postMessage({type: "refresh"});
	}
	return windows;
}

async function focusOrOpen() {
	const windows = await refreshOpenClients();
	if (windows.length > 0) {
		await windows[0].focus();
	} else {
		await self.clients.openWindow("/");
	}
}

async function answerFromNotification(payload, disposition) {
	const response = await fetch("/api/v1/answers", {
		method: "POST",
		credentials: "same-origin",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({answers: [{question_id: payload.question_id, disposition}]}),
	});
	if (!response.ok) {
		await focusOrOpen();
		return;
	}
	await setBadge((payload.outstanding || 1) - 1);
	await refreshOpenClients();
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const payload = event.notification.data || {};
	if ((event.action === "yep" || event.action === "nope") && payload.question_id) {
		event.waitUntil(answerFromNotification(payload, event.action));
		return;
	}
	event.waitUntil(focusOrOpen());
});
