import {askYepNope} from "../ask";
import {startMockBackend, type MockBackend} from "./mock-backend";

describe("askYepNope reconnect limits", () => {
	let backend: MockBackend | undefined;

	afterEach(async () => {
		await backend?.close();
		backend = undefined;
	});

	it("stops opening sockets after the consecutive failure limit", async () => {
		let connectionCount = 0;
		backend = await startMockBackend({
			onConnection(socket) {
				connectionCount += 1;
				socket.close();
			},
		});

		const outcome = await askYepNope(
			{project: "connection-test", questions: [{title: "Continue?", body: "Test bounded reconnects."}]},
			{repo: null, branch: null, worktree: null, directory: "/test/worktree"},
			{
				baseUrl: backend.baseUrl,
				heartbeatMilliseconds: 10,
				maximumConsecutiveFailures: 3,
				maximumReconnectDelayMilliseconds: 40,
				progressMilliseconds: 10,
				random: () => 0.5,
				reconnectDelayMilliseconds: 10,
				token: "ynp_test",
			},
		);

		expect({connectionCount, outcome}).toStrictEqual({
			connectionCount: 3,
			outcome: {
				dispositions: [],
				isError: true,
				text: "The yepnope answer stream stopped after 3 consecutive connection failures.",
			},
		});
	});
});
