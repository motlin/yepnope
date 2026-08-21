# YepNope

Swipe to answer your coding agent's yes/no questions.

Agents ask brief, self-contained questions through an MCP tool or the Claude Code
permission hook; the questions land on your phone as swipe cards. Right is yep,
left is nope, down is skip. Every swipe is held for five seconds behind an undo
button (keyboard shortcut `u`), including the last card of a batch, so a
mis-swipe can be taken back. The agent blocks until every card is answered.

## Install the agent integration

This repository is the distribution source; YepNope does not need a separate
skills repository. The recommended plugin install bundles both YepNope skills
with the remote MCP connection.

For Codex:

```sh
codex plugin marketplace add motlin/yepnope
codex plugin add yepnope@yepnope
```

For Claude Code:

```sh
claude plugin marketplace add motlin/yepnope
claude plugin install yepnope@yepnope
```

Start a new agent session after installation and complete OAuth when the client
prompts you. The plugin does not create or replace a status line.

To install from a local checkout while developing the plugin, run:

```sh
./install-local.sh all
```

Pass `claude` or `codex` instead of `all` to update only one client. The local
installer registers this checkout as the `yepnope` marketplace, refreshes the
plugin cache, and leaves status-line settings untouched.

For a lightweight skill-only installation without the bundled MCP connection,
use the open Agent Skills installer:

```sh
npx skills add motlin/yepnope \
	--skill yepnope \
	--skill yepnope-setup \
	--global \
	--agent claude-code \
	--agent codex \
	--yes
```

That command installs both skills. Run `/yepnope-setup` in Claude Code or
`$yepnope-setup` in Codex to add and authenticate the remote MCP connection.
The skill-only path does not install project settings, status-line settings, or
background polling.

For every blocking yes-or-no decision, the agent calls `ask_yep_nope` first.
That call atomically reads the AFK state controlled by the app: it routes the
question to the phone when AFK is on and tells the agent to use its native
question flow when AFK is off. The remote MCP cannot change AFK state and does
not make a separate status request before each question.

## MCP install (`ask_yep_nope`)

There is one MCP path and it is remote: `https://yepnope.app/mcp`, authorized in
a browser. The plugin install above already registers it, so `codex mcp login
yepnope` or the equivalent Claude Code prompt is the whole setup. Nothing is
copied between windows, no token is pasted into a config file, and the
authorization appears under **Settings -> Connected MCP clients** where it can be
revoked.

To register the connection by hand instead of through the plugin:

```sh
codex mcp add yepnope --url https://yepnope.app/mcp
codex mcp login yepnope
```

The call may block for hours by design. The server emits an MCP progress
notification every 15 seconds, and harnesses that implement progress
notifications reset their tool timeout on each one, so the wait survives. For
harnesses that time the call out anyway, raise the timeout explicitly — in
Claude Code set `MCP_TOOL_TIMEOUT` (milliseconds, e.g. `MCP_TOOL_TIMEOUT=43200000`
for 12 hours) in the environment; other harnesses have equivalents.

While the call blocks, the server heartbeats the answer stream. If the agent
process dies the heartbeats stop, the batch is retracted, and the cards
disappear from the phone; a resumed agent simply asks again. While AFK mode is
off, `ask_yep_nope` returns a structured native-fallback result instead of a
card.

## Hook install (Claude Code)

The permission hook is a local shell command, so it cannot speak MCP and needs a
credential of its own. That credential is an ordinary OAuth grant obtained by
[RFC 8628 device authorization](https://datatracker.ietf.org/doc/html/rfc8628):
short-lived, refreshable, scoped exactly like the remote MCP connection, and
revocable from the same **Settings -> Connected MCP clients** list. It is stored
in the operating system keychain — never in an environment variable, never in a
file, never in `settings.json`.

Nothing is published to a registry yet, so build the CLI from this checkout:

```sh
vp run build:cli
node "$PWD/cli/dist/yepnope.cjs" login
```

`login` prints an eight-character code and a URL. Open the URL in a browser
signed in to your account, check which client is asking and what it will be able
to do, and approve. The command stores the resulting credential in the keychain
and exits; the code itself authorizes nothing and is useless once approved or
expired (ten minutes).

Then point the hooks at the same command. It takes the hook JSON on stdin and
writes the decision on stdout, so no credential appears in `settings.json`, in
the process arguments, or in a shell history:

```json
{
	"hooks": {
		"PermissionRequest": [
			{
				"hooks": [
					{
						"type": "command",
						"command": "node \"$CLAUDE_PROJECT_DIR/cli/dist/yepnope.cjs\" hook",
						"timeout": 3600
					}
				]
			}
		],
		"PreToolUse": [
			{
				"matcher": "AskUserQuestion",
				"hooks": [
					{
						"type": "command",
						"command": "node \"$CLAUDE_PROJECT_DIR/cli/dist/yepnope.cjs\" hook",
						"timeout": 3600
					}
				]
			}
		]
	}
}
```

While AFK mode is on, permission prompts become swipe cards and
`AskUserQuestion` is redirected to `ask_yep_nope`. While it is off, both hooks
abstain and everything runs natively. A new account starts with AFK off, because
routing questions to a phone means nothing until an MCP client is connected, and
revoking the last client turns it off again; the app toggle and `afk on` below
are how it goes back on. Hook decisions do not bypass permission rules.

The hook sets no timeout of its own, deliberately: a card can sit on a phone for
hours, and the request stays open for exactly as long as you take to swipe it.
Claude Code's own per-hook timeout is therefore the only cutoff, and its default
is far shorter than that, so set `timeout` explicitly as above — in seconds, and
long enough that you would rather answer late than answer in the terminal. When
it does expire the card is abandoned and the prompt falls through to the
terminal, which is the same safe outcome as an abstention.

The hook abstains rather than failing whenever it cannot get an answer — no
credential, a revoked credential, an unreachable service — and says why on
stderr. A laptop that is offline falls back to the native prompt instead of
stranding the agent.

`node "$PWD/cli/dist/yepnope.cjs" logout` revokes the credential and removes it
from the keychain. Revoking the client under **Settings -> Connected MCP
clients** does the same thing from the other end and takes effect on the hook's
very next call, even though its access token has not expired yet.

## AFK mode and optional status output

The app toggle is the primary AFK control because it remains available after
you leave your computer. The CLI provides the same global per-user control for
when you are leaving deliberately:

```sh
node "$PWD/cli/dist/yepnope.cjs" afk          # show the current state
node "$PWD/cli/dist/yepnope.cjs" afk on       # route new questions to YepNope
node "$PWD/cli/dist/yepnope.cjs" afk off      # use native prompts for new questions
```

Changes apply to the next question only. Turning AFK mode off does not retract
cards already on the phone or strand agents waiting for those answers.

`afk on` is refused with `Authorize an MCP host or OAuth CLI client before
turning AFK on.` while no MCP client is connected, and AFK reads as off whenever
the last one goes away. Routing questions to a phone is meaningless with nothing
to route, so connect a client first; the app toggle behaves the same way.

`afk statusline` is a one-shot command that prints `📱 YepNope: ON` or
`💻 YepNope: OFF`; a missing authorization or a server failure produces a warning
within a 1.5-second deadline. It does not start a server or install a timer.

YepNope must not create or replace a project or user `statusLine`. To make
composition discoverable while leaving the status line under its owner's
control, expose the one-shot command as `YEPNOPE_STATUSLINE_COMMAND`. This
repository does that without defining `statusLine`:

```json
{
	"env": {
		"YEPNOPE_STATUSLINE_COMMAND": "node \"$CLAUDE_PROJECT_DIR/cli/dist/yepnope.cjs\" afk statusline"
	}
}
```

An existing user-owned status-line script may explicitly invoke that trusted
command when it already refreshes for a normal Claude Code event. YepNope does
not add `refreshInterval`, so it never introduces a perpetual background poll.
The command ignores Claude Code's session JSON on stdin. `YEPNOPE_URL`
overrides the service URL for development. See Claude Code's official
[statusline documentation](https://code.claude.com/docs/en/statusline) for
composition details.

The shared `yepnope` Agent Skill performs one setup check when it first needs
the tool. If setup is missing, Claude Code recommends `/yepnope-setup`; Codex
recommends `$yepnope-setup`. Neither skill edits status-line settings or starts
background monitoring.

## Appearance

The app ships light and dark palettes and follows the device by default. The
choice lives under **Settings → Appearance** as three radios — Light, Dark, and
Match system — and is remembered in this browser's `localStorage` under
`yepnope.theme`. It is a device preference, not account state: it is never
written to D1 and never travels through the Worker, so two browsers signed into
the same account can look different on purpose.

While the choice is _Match system_, `prefers-color-scheme` decides on its own
and a system change repaints immediately, with no reload. An explicit choice
writes `data-theme` on `<html>` and outranks the system in both directions. A
small script in `index.html` applies a stored choice before the first paint, so
the other palette never flashes.

Every colour in `src/app.css` is a custom property declared in light on bare
`:root` and redefined for dark; `tests/theme-contrast.test.ts` reads that
stylesheet and fails the build if any surface drops below WCAG AA or if a
colour literal reappears outside the palette blocks.

## Sign-in methods

An account can be reached by email and password, a passwordless emailed
sign-in link, a passkey, and any configured social provider. All of them
resolve to the same account: linking requires the provider's own verified-email
claim and an exact address match, and Better Auth's local-verification gate
means a pre-registered but unverified account cannot absorb someone else's
social identity. Passkeys and providers are added and removed under **Settings
-> Sign-in methods**; the last remaining method cannot be disconnected.

`GET /api/v1/auth-methods` reports what the running deployment can actually
complete, and the sign-in page renders only those methods, so a deployment
without provider secrets never shows a button that would dead-end.

### Configuring social providers

GitHub and Google are the two providers the client knows how to render. Each is
enabled purely by setting both of its secrets; unset either one and the provider
disappears from the sign-in page and is rejected by the API.

1. Register the OAuth application with the provider and set its callback URL to
   `https://yepnope.app/api/auth/callback/github` or
   `https://yepnope.app/api/auth/callback/google`. Google additionally needs
   `https://yepnope.app` as an authorized JavaScript origin, and its consent
   screen must request the `email` and `profile` scopes so the verified-email
   claim arrives.
2. Store the credentials as Wrangler secrets, never as `vars`:

    ```sh
    wrangler secret put GITHUB_CLIENT_ID
    wrangler secret put GITHUB_CLIENT_SECRET
    wrangler secret put GOOGLE_CLIENT_ID
    wrangler secret put GOOGLE_CLIENT_SECRET
    ```

3. Redeploy with `just release` (see
   [Releasing to production](#releasing-to-production)), then confirm the provider
   is advertised:

    ```sh
    curl -s https://yepnope.app/api/v1/auth-methods
    ```

For local development, put the same names in `.dev.vars` (see
`.dev.vars.example`) and register a second OAuth application whose callback URL
points at your dev origin. Provider credentials are per-origin; never reuse the
production application's secrets locally.

`BETTER_AUTH_SECRET` is likewise a Wrangler secret
(`wrangler secret put BETTER_AUTH_SECRET`, generated with
`openssl rand -base64 32`), as is `VAPID_PRIVATE_JWK`.

### Human verification on the signed-out pages

Cloudflare Turnstile gates the four surfaces an anonymous visitor can use to
make the Worker look up an account, check a password, or send mail: sign-in
(password and emailed link), create-account, password-reset request, and
verification resend. Nothing else is gated — the OAuth token exchange, the MCP
endpoint, authenticated settings, and every emailed link that already carries a
single-use credential are untouched.

The widget is only the visible half. `worker/turnstile.ts` redeems every token
with Cloudflare Siteverify **before** Better Auth sees the request, and requires
`success`, the action of the surface that minted it, and this deployment's own
hostname — taken from `BETTER_AUTH_URL`, so a production Worker can never accept
a token minted against `localhost`. Tokens are single-use, so a replayed one is
refused. A missing, forged, expired, oversized, or unredeemable token, an
unreachable Siteverify, and a half-configured deployment all produce the same
403 and the same message, which says nothing about whether the address exists.
Turnstile supplements the existing per-requester and per-destination limits; it
replaces none of them.

1. Create a widget for `yepnope.app` in
   [the Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
   in **Managed** mode.
2. Store both halves as Wrangler secrets. The site key is public, but keeping the
   pair together means a deploy cannot drop one of them:

    ```sh
    wrangler secret put TURNSTILE_SITE_KEY
    wrangler secret put TURNSTILE_SECRET_KEY
    ```

3. Redeploy with `just release` (see
   [Releasing to production](#releasing-to-production)), then confirm the browser
   is being told to draw the widget:

    ```sh
    curl -s https://yepnope.app/api/v1/auth-methods
    ```

    A `turnstile_site_key` of `null` on a production origin means the pair is not
    set, and every public authentication request is being refused.

**Both keys, or neither.** Setting exactly one is a configuration mistake and
fails closed. Setting neither is allowed only when `BETTER_AUTH_URL` is
loopback, which is how `vp dev` runs without a widget; see `.dev.vars.example`.

**Rolling back.** Deleting both secrets
(`wrangler secret delete TURNSTILE_SITE_KEY` and
`wrangler secret delete TURNSTILE_SECRET_KEY`) on a production origin does _not_
disable the check — it locks the sign-in pages. To remove the gate from a
deployed Worker, redeploy the previous release; to remove it from the codebase,
revert the change. There is no runtime kill switch, deliberately: a silent
bypass is worth more to an attacker than to an operator.

**Rotating the secret.** The secret key can be rotated without a code change or
downtime, because the site key does not change and Cloudflare keeps redeeming
tokens minted before the rotation for their normal lifetime:

1. Rotate the secret in the widget's dashboard settings.
2. `wrangler secret put TURNSTILE_SECRET_KEY` with the new value. The next
   request picks it up; no redeploy is needed.
3. Watch for `human_verification_evaluated` observations with
   `reason: "misconfigured"`, which is what a wrong secret looks like.

Rotating the **site key** means creating a new widget, so set both secrets in the
same window and expect the visitors mid-solve to retry once. `/api/v1/auth-methods`
carries the site key under `Cache-Control: public, max-age=300`, so a browser
holding the previous response keeps drawing the old widget for up to five
minutes and its tokens are refused until it refetches. Keep the old widget alive
until that window has passed.

**What is recorded.** A cleared check leaves no log line at all; solve volume is
Cloudflare's own analytics to report, under Turnstile → your widget, which shows
challenge and solve rates without identifying anyone. A refusal logs one
`human_verification_evaluated` observation whose `reason` is a member of a closed
set (`missing_token`, `spent_token`, `action_mismatch`, `hostname_mismatch`,
`rejected_challenge`, `malformed_token`, `misconfigured`, `unavailable`). No
token, address, password, cookie, IP address, or Siteverify body is ever
recorded.

### Passkeys and emailed sign-in links

Both are enabled unconditionally and need no secrets. Passkeys are bound to the
relying party derived from `BETTER_AUTH_URL`, so changing that hostname
invalidates every registered passkey. Emailed sign-in links expire in 15
minutes, are stored only as a hash, and are delivered through the same
Cloudflare `send_email` binding as verification and password-reset mail.

### 📮 Email delivery to people who are not you

Every authentication message leaves through the `send_email` binding, and
Cloudflare gates who may receive one. **Until a sending domain is onboarded to
Cloudflare Email Service, the binding can only reach addresses already verified
as Email Routing destinations in the account.** Your own address is one of
those, so registration looks healthy from your inbox while every genuinely new
account is stranded: the Worker's non-enumerating reply says the request was
accepted, the message is rejected, and nothing arrives.

Onboard the domain in the dashboard under **Compute -> Email Service -> Email
Sending -> Onboard Domain** (Workers Paid plan; the zone must use Cloudflare
DNS). Cloudflare then publishes the `cf-bounce` MX, SPF, DKIM, and DMARC records
that let arbitrary recipients accept the mail.

Delivery failures never reach the browser, so the Worker classifies them into a
redacted vocabulary instead — `recipient_rejected`, `sender_rejected`,
`throttled`, `message_rejected`, `transient` — logged as
`authentication_email_delivery_failed` with no address, link, or token. Only
`transient` is retried, up to three attempts on the one already-minted message,
so a retry never yields a second usable verification token. Alongside it,
`authentication_verification_state_classified` records whether a verification
request found an `unverified_account`, an `already_verified` account, or an
`unknown_account`, which is the only place that distinction exists: the HTTP
response is byte-identical for all three.

### Verifying a deployment

After each deploy, exercise every advertised method against production once:
sign in with email and password, request an emailed link and follow it,
register and then use a passkey, and complete each configured provider's
round trip. `/api/v1/auth-methods` is the checklist — every `true` and every
listed provider needs one pass.

Then run the delivery smoke check, which reads the sending-domain onboarding
state, Email Service activity for the last seven days, and D1's verification
token counts. It reports counts and statuses only, never an address, link, or
token, and exits non-zero when anything is degraded:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... \
  YEPNOPE_D1_DATABASE_ID=... YEPNOPE_SENDING_DOMAIN=yepnope.app \
  npm run smoke:verification-delivery
```

The API token needs Analytics Read for the zone plus D1 read for the account.
Note that Worker sends show up in the Email **Routing** summary as dropped even
when they were delivered; the Email **Sending** metrics this script reads are
the authoritative record.

## Releasing to production

`just release` is the supported path to production; a bare `vp run deploy` skips
every guard below.

```sh
just release --dry-run   # print the guards and the tag a release would cut
just release             # verify, tag, deploy, push
```

The recipe refuses to start on a dirty working tree, on a branch with no
upstream, or on a branch behind its upstream. It then runs `just verify`, cuts
an annotated tag on the current commit, deploys with `vp run deploy`, rewrites
the annotation with the Cloudflare Version ID that deploy reported, and pushes
the tag last.

`package.json` stays at `0.0.0` — nothing installs YepNope from a registry — so
the release version is the UTC date plus the short commit, `v2026.08.20-abc1234`.
One tag per released commit: re-running the recipe on an already-released commit
fails instead of retagging.

The tag is cut before the deploy so the deployed tree is exactly the tagged tree,
and it is pushed only after Wrangler names a version, so every pushed tag maps to
one deployment:

```sh
git show v2026.08.20-abc1234 --no-patch
# YepNope release v2026.08.20-abc1234
#
# Deployed commit abc1234 to yepnope.app.
# cloudflare_version_id: 1d9f8b6a-4c2e-4f77-9b32-2f6c9c9c7a11
```

Nothing partial survives. A failed `just verify` never tags. A failed deploy, or
a deploy that prints no Version ID, deletes the unpushed tag and exits non-zero.
A failed push reports the deployed version ID and the `git push` command that
finishes the release. `tests/release.test.ts` covers that ordering and each
guard. The administration Worker is released separately with
`npm run deploy:admin`.

## Privacy and retention

YepNope can read question bodies and answers stored by the service. End-to-end
encryption is not part of the MVP. Question bodies and answers are deleted seven
days after each batch is created. Content-free counters are retained after that
content is deleted.

A nightly Worker cron (`0 4 * * *`) sweeps expired records and logs one
count-only line, `scheduled_cleanup_completed`. Part of that sweep reclaims
abandoned OAuth clients: Dynamic Client Registration lets an MCP client register
itself before anyone consents, so every `codex mcp login` that stops short of
consent leaves a row behind. A registered client is reclaimed once it is seven
days old, holds no consent, holds no access or refresh token, and has no
unexpired authorization in flight. Anything short of all four spares it. Count
the rows the predicate would take before it takes them, without deleting
anything:

```sh
npm run dry-run:oauth-client-reclamation
```

The dry run issues nothing but `SELECT count(*)`, reads the production database
through `wrangler d1 execute --remote`, and reports counts only. Deleting is the
cron's job alone.

## Development

```sh
just install   # install dependencies
just dev       # run the dev server
just verify    # check, build, dead-code sweep, pre-commit hooks, tests
just release   # verify, tag, deploy to production, push the tag
```

Card layout mockups live in `mockups/index.html` — a self-contained page used to
measure title/body character limits at iPhone dimensions.

### Storage administration

The storage administration Worker is deployed separately on
`admin.yepnope.app` with `wrangler.admin.jsonc`; the public application has no
maintenance route. Before deployment, create a Cloudflare Access self-hosted
application for that exact hostname with a Service Auth policy, then configure
the Worker's `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` variables. Deploy with
`npm run deploy:admin` so dashboard-managed variables are preserved.

The administration CLI requires `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`, `YEPNOPE_DO_NAMESPACE_ID`, `YEPNOPE_ADMIN_URL`,
`CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`. It emits table counts and
known object IDs, never stored credentials or content. Cloudflare's List Objects
entries are stable known IDs, not a count of live or allocated Durable Objects.
Diagnostics headline the number of IDs where `hasStoredData=true` and report
known empty IDs separately:

```sh
npm run admin:storage -- diagnostics
npm run admin:storage -- cleanup
npm run admin:storage -- cleanup --confirm --expected-count 3
```

Cleanup defaults to a dry run. A confirmed cleanup repeats the complete
cursor-paginated namespace inventory, refuses an inventory or ownership race,
deletes one orphan at a time, and verifies each object's storage was
deallocated before continuing. `deleteAll()` deallocates SQLite, key-value, and
alarm storage, but Cloudflare may retain the Durable Object's stable identity in
the namespace inventory with `hasStoredData=false`. Cleanup is complete when no
target ID has stored data, even if known empty IDs remain; do not rotate the
namespace merely to force the known-identity count to zero. After a partial
failure, rerun the dry run and confirm its new orphan stored-object count.
