# YepNope

Swipe to answer your coding agent's yes/no questions.

Agents ask brief, self-contained questions through an MCP tool or the Claude Code
permission hook; the questions land on your phone as swipe cards. Right is yep,
left is nope, down is skip. Every swipe is held for five seconds behind an undo
button (keyboard shortcut `u`), including the last card of a batch, so a
mis-swipe can be taken back. The agent blocks until every card is answered.

## Set up the phone

Installing the agent integration is only half of it; the questions have to land
somewhere.

1. Open <https://yepnope.app> on the phone and create an account. Email and
   password, an emailed sign-in link, a passkey, and any configured social
   provider all reach the same account; see
   [Sign-in methods](#sign-in-methods).
2. On iPhone, install the app before anything else: tap **Share**, choose
   **Add to Home Screen**, leave **Open as Web App** on, then open YepNope from
   its Home Screen icon. iOS delivers web push only to an installed PWA.
3. Turn on **Settings -> Browser notifications**. That registers this browser's
   push subscription and nothing else: one notification per batch of questions.
   Signing in on a second browser does not enrol it, and
   **Settings -> Signed-in browsers** lists the ones that are.
4. Install the agent integration below, then turn **AFK** on from the deck. The
   toggle reads `Connect an agent` and does nothing until one is authorized,
   because routing questions to a phone means nothing with nothing to route.
   That button, and **Settings -> Connected MCP clients -> Connect an MCP
   client**, both open <https://yepnope.app/connect>, which carries the
   per-client setup steps.

## Install the agent integration

This repository is the distribution source; YepNope does not need a separate
skills repository. The recommended plugin install bundles both YepNope skills
with the remote MCP connection.

For Codex:

```sh
codex plugin marketplace add motlin/yepnope
codex plugin add yepnope@yepnope
```

Do not also run `codex mcp add yepnope`: the plugin already owns that server.
If Codex had a direct YepNope MCP registration before the plugin was installed,
run `$yepnope-setup`; it detects the overlapping source without printing Codex
configuration and asks before removing the redundant top-level entry.

For Claude Code:

```sh
claude plugin marketplace add motlin/yepnope
claude plugin install yepnope@yepnope
```

Start a new agent session after installation and complete OAuth when the client
prompts you. In Codex, review and trust the packaged question-routing hook with
`/hooks`; Codex skips new or changed plugin hooks until they are trusted. The
plugin does not create or replace a status line.

To install from a local checkout while developing the plugin, run:

```sh
./install-local.sh all
```

Pass `claude` or `codex` instead of `all` to update only one client. The local
installer needs `jq` and the client CLI it is installing for. It registers this
checkout as the `yepnope` marketplace, reinstalls the plugin to refresh the
cache, and leaves status-line settings untouched.

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
background polling. It also cannot install the Codex question-routing hook that
the plugin bundles.

Before every user-facing yes-or-no question, the agent calls `ask_yep_nope`
first, without applying an importance or rework-cost threshold. That call
atomically reads the AFK state controlled by the app: it routes the question to
the phone when AFK is on and tells the agent to use its native question flow
when AFK is off. The remote MCP cannot change AFK state and does not make a
separate status request before each question.

The Codex plugin reinforces that rule as developer context on every user turn,
blocks supported native question tools until a YepNope attempt occurs, and
checks final assistant text once for a question that bypassed a tool. The hook
stores only per-turn routing outcomes in the plugin data directory; it does not
store prompts or question text. Codex hooks cannot cover every specialized tool
path, so the skill and MCP descriptions remain the primary routing contract.

## MCP install (`ask_yep_nope`)

There is one MCP path and it is remote: `https://yepnope.app/mcp`, authorized in
a browser. The plugin install above already registers it, so `codex mcp login
yepnope` or the equivalent Claude Code prompt is the whole setup. Nothing is
copied between windows, no token is pasted into a config file, and the
authorization appears under **Settings -> Connected MCP clients** where it can be
revoked.

To register the connection by hand instead of through the plugin, use the
following commands. These are alternative installation paths; do not combine
them with the plugin install. In Claude Code:

```sh
claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp
```

Then run `/mcp`, select `yepnope`, and authorize in the browser. In Codex:

```sh
codex mcp add yepnope --url https://yepnope.app/mcp
codex mcp login yepnope
```

`codex mcp login` opens the default browser itself and also prints the
authorization URL. The printed line reads ``Authorize `yepnope` by opening
this URL in your browser:``, which sounds like an instruction, but the tab is
already loading by the time it appears; verified against `codex-cli 0.150.1`.
Copy the printed URL by hand only when that launch cannot work — a headless
host, an SSH session, or a machine with no default browser — and finish
authorization there. The launch belongs entirely to the local Codex process,
which opens the browser before it waits on the loopback callback it
registered. No YepNope endpoint, skill, or plugin hook takes part in it, and
`codex mcp login --help` exposes no flag that suppresses it.

<https://yepnope.app/connect> repeats these mutually exclusive plugin and
manual paths, so the phone is enough to finish setup. It also carries the
registration for the MCP clients YepNope ships no plugin for: Cline, Cursor,
Goose, VS Code with GitHub Copilot, Windsurf, and Zed. Every one of those
connects to the same remote server over the same OAuth flow, with no bearer
token and no `mcp-remote` proxy; only the shape of the config differs, and the
page carries each client's own current syntax. **Settings -> Connected MCP
clients** links to that page and lists the grants that already exist.

### Migrate a pre-OAuth installation

An old local stdio registration cannot be upgraded in place: its bearer
credential cannot become an OAuth grant. Remove that client entry, register the
remote URL, and authorize the existing YepNope account in the browser.

For Claude Code installations that used the former local-scope setup:

```sh
claude mcp remove --scope local yepnope
claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp
```

Then run `/mcp`, select `yepnope`, and authorize. For Codex with the plugin
installed, remove the legacy top-level registration and use the bundled server:

```sh
codex mcp remove yepnope
codex mcp login yepnope
```

For a skill-only Codex installation without the plugin, replace the old
registration by hand:

```sh
codex mcp remove yepnope
codex mcp add yepnope --url https://yepnope.app/mcp
codex mcp login yepnope
```

After the OAuth connection succeeds, remove the old local shim bundle and its
bearer-credential setting. This changes only the client installation: browser
sessions, the account, questions, push subscriptions, and the account's Durable
Object stay where they are.

The call may block for hours by design, and two separate client limits can cut
it short. The first is an idle window: Claude Code aborts a tool call that has
sent neither a response nor a progress notification for five minutes. When the
client sends a progress token the server emits a progress notification every 15
seconds, which holds that window open indefinitely. The second is a wall-clock
limit on the call as a whole, and progress notifications do **not** extend it —
Claude Code's own per-server `timeout` says so in as many words.

So the plugin ships the wall-clock limit rather than asking for it. Its
`.mcp.json` carries `"timeout": 691200000` for Claude Code and
`"tool_timeout_sec": 691200` for Codex; each client honors its own key and
ignores the other's. Eight days is one day longer than the seven-day window the
server itself waits before giving up, so the server's graceful timeout always
wins the race. Installing the plugin is the whole configuration: a per-server
value outranks `MCP_TOOL_TIMEOUT` and raises the idle window to match it, so
nothing in the environment can cut a blocking question short.

Losing that race is destructive, which is why the margin exists. A client that
gives up first sends `notifications/cancelled`, the server retracts the batch,
and the cards vanish off the phone while the user is mid-answer — and the agent
collects a timeout instead of a yep.

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
Because loopback is the legal case, no test can catch the production one —
the browser suite runs against a loopback Worker — so
[the deployment preflight](#the-deployment-preflight) refuses to release a
`yepnope.app` deploy that is missing either key.

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

### Recovering an account

Recovery is proof that you can read the registered inbox, and nothing else. It
re-establishes a session for the same account, which is the same Durable Object
under the same user id, so the questions and settings that come back are the
ones that were already there. Nothing is merged, moved, or claimed.

`/forgot-password` offers the two emails that carry that proof, both against the
address typed into its one field and both gated by its one Turnstile widget:

- **A password-reset link.** Better Auth mints one for any account with that
  address and attaches a credential when the link is redeemed, so this works
  even for an account that never had a password.
- **An emailed sign-in link.** The same 15-minute link the sign-in page offers.
  It is the shorter path for an account created with a link, a passkey, or a
  provider, because it asks the owner to invent nothing.

There is no separate recovery token type and no recovery endpoint. Both paths
are ordinary authentication, so they inherit its non-enumeration: identical body,
status, and 500 ms timing floor whether or not the address has an account.

The registered address cannot be changed from the app, so losing that mailbox
means losing the account.

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

The core loop itself is covered by
[the deployed check](#proving-the-core-loop-on-a-deployment), which `just release`
runs against staging before it tags. What remains here is the signed-out
authentication surface, which no robot can drive.

After each deploy, exercise every advertised method against production once:
sign in with email and password, request an emailed link and follow it,
register and then use a passkey, and complete each configured provider's
round trip. `/api/v1/auth-methods` is the checklist — every `true` and every
listed provider needs one pass. Then recover once from `/forgot-password`,
taking both the reset link and the sign-in link, and confirm each lands back on
the same account's deck.

The robot's share of that pass is `tests/deployed/sign-in-surface.spec.ts`. It
reads `/api/v1/auth-methods`, checks the sign-in page draws an entry point for
every advertised method, confirms the gated routes refuse a request with no
human token and that Turnstile refuses to mint one for an automated browser,
asks each provider for its authorization URL and checks the client and callback
it names, and checks passkey challenges name the deployment as relying party.
It creates no account, no session, and no email:

```sh
npm run smoke:sign-in-surface                                   # against https://yepnope.app
YEPNOPE_DEPLOYMENT_ORIGIN=https://... npm run smoke:sign-in-surface   # against staging
```

The human share is the sign-ins themselves, as listed above.

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
just release --dry-run   # print the guards, the preflight, and the tag a release would cut
just release             # preflight, verify, rehearse on staging, tag, deploy, push
```

The recipe refuses to start on a dirty working tree, on a branch with no
upstream, or on a branch behind its upstream. It then runs the deployment
preflight below, runs `just verify`, deploys the tree to staging and proves the
core loop there, cuts an annotated tag on the current commit, deploys with
`vp run deploy`, rewrites the annotation with the Cloudflare Version ID that
deploy reported, and pushes the tag last.

### The deployment preflight

Every other guard asks the repository a question. `scripts/preflight.ts` asks
Cloudflare one, because a perfect repository can still be deployed onto a Worker
that is missing something it reads at runtime — and the Worker fails closed, so
the operator learns about it from visitors. It enumerates every binding, var, and
secret `worker/` reads, then checks each against
`wrangler deploy --dry-run` and `wrangler secret list`:

```sh
just release --dry-run
# "deployment": {
#   "bindings": ["AUTH_EMAIL_FROM", "BETTER_AUTH_URL", "DB", "EMAIL", "USER_DO", "VAPID_SUBJECT"],
#   "secrets": ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY", "VAPID_PRIVATE_JWK"],
#   "target": "yepnope.app"
# }
```

A missing name stops the release before `just verify` runs and before any tag
exists, and the refusal names every unmet requirement at once with the command
that fixes it. `BETTER_AUTH_URL` is checked by value as well as presence: it has
to be the production origin, since it is the hostname every Turnstile token is
redeemed against. Social-provider credentials are deliberately not required —
a deployment without a provider's pair simply never offers that provider.

Only `just release` runs it. A bare `wrangler deploy` deploys whatever is there.

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

### Proving the core loop on a deployment

Everything else in this repository is green in a process on this machine. The
unit suite, the workerd suite, and the browser suite all run against a loopback
Worker whose mail and Siteverify are substituted, so none of them can tell
whether a real Cloudflare deployment still does the one thing the product is
for: carry a question from an agent, through OAuth and a Durable Object and a
WebSocket, onto a phone, and back into the blocking tool call.

`tests/deployed/core-loop.spec.ts` is the check that can. It runs against a
deployed origin with no stand-ins — the deployment under test has no
`/api/__e2e__` back door — and in one pass it:

- reads the RFC 8414 and RFC 9728 metadata off the live origin;
- registers an MCP client through Dynamic Client Registration, authorizes it on
  the real consent page, and exchanges the code with PKCE;
- connects a real Streamable HTTP MCP client over the public internet;
- turns routing on, calls `ask_yep_nope` with a three-question batch, and
  answers it with three swipes on the deck — Yep, Nope, Skip;
- asserts the call is **still blocking** while the deck offers to undo the last
  swipe, and that it returns only after that five-second window closes;
- authorizes a second MCP client on the same account and answers its question
  from a deck that was already open;
- cancels a call and watches the card leave that already-open deck over the live
  socket;
- revokes both clients and turns routing back off.

```sh
just deploy-staging                    # deploy this tree to the staging Worker
just check-deployment                  # prove the loop on $YEPNOPE_DEPLOYMENT_ORIGIN
just check-deployment https://elsewhere.example.workers.dev
```

`just release` runs both of those for you, against staging, before it cuts a
tag. A core loop that no longer works stops the release with nothing tagged and
production untouched.

**What a person has to do, once per deployment.** The signed-out surface is
[Turnstile-gated](#human-verification-on-the-signed-out-pages) —
create-account, password sign-in, emailed sign-in links, password reset, and
verification resend — and finishing a registration means reading a message that
was delivered to a real inbox. Neither is automatable, and nothing here weakens
the gate to pretend otherwise. So:

1. Create `wrangler.staging.jsonc`'s database with
   `vp exec wrangler d1 create yepnope-staging`, paste the id it prints, apply
   `worker/migrations/d1` to it with `--remote`, and set staging's own
   `BETTER_AUTH_SECRET` and `VAPID_PRIVATE_JWK` secrets. A staging Turnstile
   pair is optional: nothing the check does is behind the gate.
2. `just deploy-staging`, then set `BETTER_AUTH_URL` in `wrangler.staging.jsonc`
   to the origin Wrangler printed and deploy again. The preflight refuses to
   release while that value is still its placeholder.
3. Create one account on staging by hand, in a browser, and follow the
   verification link.
4. `just enroll-deployment-passkey`. It opens a window, waits for you to sign
   in, registers one passkey against a Chrome virtual authenticator, and prints
   the credential. Store it as `YEPNOPE_DEPLOYMENT_PASSKEY` and the staging
   origin as `YEPNOPE_DEPLOYMENT_ORIGIN`.

After that the check runs with nobody present. Passkey sign-in is the one
authenticated entry point that is not Turnstile-gated, so each run signs itself
in through the real WebAuthn ceremony — the deployment verifies the signature
against the public key it recorded at enrollment; the only thing standing in for
hardware is the authenticator holding the private key. There is no session to
expire and no inbox to poll.

The check refuses to run against `yepnope.app` unless
`YEPNOPE_DEPLOYMENT_ALLOW_PRODUCTION=1` is set by name, because it turns routing
on and answers the questions it asks — which on production happens on the real
phone. `tests/deployment-check.test.ts` covers those refusals.

Nothing partial survives. A failed `just verify` never tags. A failed deploy, or
a deploy that prints no Version ID, deletes the unpushed tag and exits non-zero.
A failed push reports the deployed version ID and the `git push` command that
finishes the release. `tests/release.test.ts` covers that ordering and each
guard, and `tests/preflight.test.ts` covers the preflight. The administration
Worker is released separately with `npm run deploy:admin`.

## Privacy and retention

YepNope can read question bodies and answers stored by the service. End-to-end
encryption is not part of the MVP. Question bodies and answers are deleted seven
days after each batch is created. Content-free counters are retained after that
content is deleted.

The app says the same thing before anyone signs up: the signed-out landing, the
sign-in form, and the account-creation form each carry that paragraph, along
with the disclosure that submitting either form sends the browser through a
Cloudflare Turnstile check. Account settings repeat it once signed in.

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

### Reading a failed browser run

The browser suite runs 47 specs, in file-name order, against one `wrangler dev`
that lives for the whole run. That one server is shared state, so a spec can
fail for something another spec did to it, or for something the server did to
itself. Two files exist to tell those apart from a real regression:

- `.llm/browser-e2e-server.log` — everything `wrangler dev` said, one
  ISO-timestamped line each: every request it served, every reload, and the
  reason it gave if it died.
- `.llm/playwright-report.json` — when each spec started and how long it took.

Line up the timestamps before believing a failure. Two patterns are the server
rather than the code:

- **`⎔ Reloading local server...`** — the Worker was replaced mid-run. A reload
  builds a fresh module scope, so the e2e Worker's captured mailbox empties and
  human verification reverts to waived, and any request in flight comes back as
  a `503` whose body is prose rather than JSON. Only
  `service-worker-upgrade.spec.ts` is allowed to cause one, and it waits for the
  reload to settle before it finishes; a reload anywhere else means something
  wrote into `dist/`, which is the directory the server serves and watches.
- **`the browser test server exited on its own`** — `wrangler dev` died, and
  every spec after that point failed on a refused connection rather than on
  anything it was testing. The run is reported as failed for that reason and
  says so in those words. In `~/Library/Preferences/.wrangler/logs/` it appears
  as `Error inside ProxyWorker … Network connection lost.`

    This is the dev server, not the Worker. `wrangler dev` serves through a proxy
    Worker that pools its connections to yours, those connections are dropped at
    five seconds idle, and a request timed to arrive on that boundary is written
    into a socket that is already gone. Because the Worker's URL has not changed
    the proxy calls that fatal, rather than returning the `503` it returns after a
    reload, and the process exits. A Worker whose entire body is
    `return new Response("ok")` dies the same way when one request follows another
    by 4997 ms, with no Durable Object, no held-open response and no MCP call in
    it anywhere.

    It surfaces in `oauth-mcp-lifecycle.spec.ts` because that spec is the only
    place in the suite that goes quiet for exactly five seconds. A swipe both
    flushes the previously held answer and starts a fresh
    `UNDO_WINDOW_MILLISECONDS`, so the last answer of a batch is posted one undo
    window — 5000 ms — after the one before it, with nothing else touching the
    server in between. The request that dies is that `POST /api/v1/answers`, and
    it never reaches the Worker at all; the blocking `ask_yep_nope` call it would
    have released is a bystander rather than the cause. Nothing here can prevent
    it and retrying it would only hide it, so what matters is that it is never
    mistaken for a regression.

    Measured over 22 runs that reached that spec: 3 died this way, near enough one
    in seven. A run of 12 back-to-back `vp run test:browser` saw none of them,
    because the machine was loaded enough to push the answer `POST` past the
    boundary it has to hit — the same load failed 5 of those 12 on unrelated 90
    second `toBeVisible()` timeouts, which is its own reason not to read one red
    run as a verdict.

### Collapsing the migrations

There are two migration sets and they are not governed the same way.

`worker/migrations/d1` is an ordinary forward chain. Change
`worker/db/d1-schema.ts`, run
`npx drizzle-kit generate --config drizzle-d1.config.ts --name <name>`, rename
the file and its journal tag to the next `NNN_` number, and apply it. Nothing
about that needs a wipe.

`worker/migrations/do` is a single immutable baseline.
`UserDurableObject.initialize()` asserts the bundle holds exactly one migration,
stamps its hash into `__drizzle_migrations`, and refuses to serve an object
whose ledger records anything else — so a live object can never adopt a rewritten
baseline. Changing `worker/db/do-schema.ts` therefore means regenerating that one
file **and deleting every Durable Object**, in the same operation. That is what
collapsing the chain in 2026-08 did, and it is the only reason the dead
`identity_merges` and `identity_merge_lock` could finally go. Restoring
`batches.worktree` rides on that same unreleased wipe.

The wipe deletes every account, question, answer, push subscription, OAuth
client, and consent. Every connected client — the Claude Code plugin and the
permission hook included — has to authorize again afterwards. Do not start it
without deciding to finish it: between the wipe and the redeploy the deployment
is serving a baseline no stored object matches.

```sh
just verify                                        # the baselines are proven locally first

# 1. Wipe D1, migration ledger included, then apply the single migration.
vp exec wrangler d1 execute yepnope --remote --json --command \
  "SELECT name FROM sqlite_master WHERE type = 'table'
   AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
#    write one `DROP TABLE` per name above, `d1_migrations` included, into a
#    scratch file under .llm/ and run it; nothing destructive is kept in the repo
vp exec wrangler d1 execute yepnope --remote --file .llm/wipe.sql
vp exec wrangler d1 migrations apply yepnope --remote

# 2. Wipe the Durable Objects. With no accounts left in D1 every stored object
#    is an orphan, which is exactly what cleanup deletes.
npm run admin:storage -- cleanup                   # dry run; read the orphan count
npm run admin:storage -- cleanup --confirm --expected-count <count>

# 3. Redeploy, so the baseline the code carries is the one objects apply.
just release

# 4. Prove it. Expect the 17 schema tables plus d1_migrations and nothing else,
#    no object with stored data, and a question answered end to end.
vp exec wrangler d1 execute yepnope --remote --command \
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
npm run admin:storage -- diagnostics
just check-deployment
```

Then create the account in a browser, follow the verification link, and
re-authorize each client.

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
