// 📣 Push pipeline (spec §6): one notification per batch, built from the payload —
// batch_id and counts, never question text, except single-question batches, whose
// title makes the Yep/Nope notification action buttons usable on Android and desktop.
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
	const count = payload.count || 0;
	const project = payload.project || "your agent";
	const single = count === 1 && payload.title;
	const title = single ? payload.title : `${count} questions from ${project}`;
	const options = {
		body: single ? project : "Open to swipe.",
		tag: payload.batch_id,
		data: payload,
		icon: "/icons/icon-192.png",
		badge: "/icons/badge-96.png",
	};
	if (single && payload.question_id) {
		// iOS ignores actions (spec §6.3); Android and desktop show them.
		options.actions = [
			{action: "yep", title: "Yep"},
			{action: "nope", title: "Nope"},
		];
	}
	event.waitUntil(
		Promise.all([self.registration.showNotification(title, options), setBadge(payload.outstanding || count)]),
	);
});

function readToken() {
	return new Promise((resolve) => {
		const open = indexedDB.open("yepnope", 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore("kv");
		};
		open.onerror = () => {
			resolve(null);
		};
		open.onsuccess = () => {
			const database = open.result;
			const request = database.transaction("kv").objectStore("kv").get("token");
			request.onerror = () => {
				database.close();
				resolve(null);
			};
			request.onsuccess = () => {
				database.close();
				resolve(typeof request.result === "string" ? request.result : null);
			};
		};
	});
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
	const token = await readToken();
	if (!token) {
		await focusOrOpen();
		return;
	}
	const response = await fetch("/api/v1/answers", {
		method: "POST",
		headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
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
