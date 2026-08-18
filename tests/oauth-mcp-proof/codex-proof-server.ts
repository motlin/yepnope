import {createProofBrowserSession, startProofServer} from "./fixture.ts";

const proof = await startProofServer({allowDynamicClientRegistration: true, port: 37_891});
await createProofBrowserSession(proof);

process.stdout.write(
	`${JSON.stringify({
		issuer: proof.issuer,
		resource: proof.resource,
		authorizationMetadata: `${proof.issuer}/.well-known/oauth-authorization-server`,
		protectedResourceMetadata: `${proof.origin}/.well-known/oauth-protected-resource`,
	})}\n`,
);
void proof.cancellationObserved.then(() => process.stdout.write('{"event":"cancellation-observed"}\n'));

const stop = async () => {
	await proof.close();
	process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise<void>((resolve) => {
	process.once("proof-process-does-not-stop", resolve);
});
