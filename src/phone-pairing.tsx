import {QRCodeSVG} from "qrcode.react";
import {useEffect, useState, type ReactElement, type SyntheticEvent} from "react";
import {claimPhonePairing, createPhonePairing, type PhonePairing} from "./api";

export function PhonePairingPanel(): ReactElement {
	const [pairing, setPairing] = useState<PhonePairing | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expired, setExpired] = useState(false);
	useEffect(() => {
		if (pairing === null) return undefined;
		const timeout = window.setTimeout(
			() => {
				setPairing(null);
				setExpired(true);
			},
			Math.max(0, pairing.expiresAt - Date.now()),
		);
		return () => {
			window.clearTimeout(timeout);
		};
	}, [pairing]);
	async function generate(): Promise<void> {
		setBusy(true);
		setError(null);
		setPairing(null);
		setExpired(false);
		try {
			setPairing(await createPhonePairing());
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not create a pairing code.");
		} finally {
			setBusy(false);
		}
	}
	const url = pairing === null ? null : `${window.location.origin}/pair-phone#id=${pairing.id}&code=${pairing.code}`;
	return (
		<section className="hint phone-pairing" aria-label="Pair a phone">
			<h3>Pair a phone</h3>
			<p>Sign in your phone to this account without typing your password.</p>
			{pairing !== null && url !== null && (
				<>
					<QRCodeSVG value={url} size={224} marginSize={4} title="Scan to sign in your phone" />
					<p>
						<code>
							{pairing.code.slice(0, 4)}-{pairing.code.slice(4)}
						</code>
					</p>
					<p>
						Scan with your phone camera, then tap Sign in this phone. This code works once and expires in 10
						minutes. Keep it private.
					</p>
					<p>Only scan a code you created yourself. Sign out on this desktop to cancel it.</p>
				</>
			)}
			{expired && <p role="status">The code expired. Create another to continue.</p>}
			{error !== null && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<button
				type="button"
				disabled={busy}
				onClick={() => {
					void generate();
				}}
			>
				{busy ? "Creating code…" : pairing === null ? "Create QR code" : "Replace QR code"}
			</button>
		</section>
	);
}

export function PairPhone(): ReactElement {
	const [parameters] = useState(() => new URLSearchParams(window.location.hash.slice(1)));
	const [code, setCode] = useState(() => parameters.get("code") ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const id = parameters.get("id");
	useEffect(() => {
		window.history.replaceState(null, "", window.location.pathname);
	}, []);
	async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (id === null) return;
		setBusy(true);
		setError(null);
		try {
			await claimPhonePairing(id, code);
			window.location.replace("/settings");
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not pair this phone.");
			setBusy(false);
		}
	}
	return (
		<main className="settings">
			<section className="hint phone-pairing">
				<h1>Sign in this phone</h1>
				<p>
					Continue only if you just created this QR code in your own signed-in YepNope desktop account. This
					phone will have access to that account.
				</p>
				{id === null ? (
					<p>
						Create a QR code under Settings → Pair a phone on your signed-in desktop, then scan it with this
						phone.
					</p>
				) : (
					<form
						onSubmit={(event) => {
							void submit(event);
						}}
					>
						<label htmlFor="pairing-code">Pairing code</label>
						<input
							id="pairing-code"
							autoCapitalize="characters"
							autoComplete="off"
							spellCheck={false}
							maxLength={64}
							value={code}
							onChange={(event) => {
								setCode(event.target.value);
							}}
							required
						/>
						<button type="submit" disabled={busy}>
							{busy ? "Signing in…" : "Sign in this phone"}
						</button>
					</form>
				)}
				{error !== null && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
			</section>
		</main>
	);
}
