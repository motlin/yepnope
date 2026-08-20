# YepNope

Swipe to answer your coding agent's yes/no questions.

Agents ask brief, self-contained questions through an MCP tool or the Claude Code
permission hook; the questions land on your phone as swipe cards. Right is yep,
left is nope, down is skip. The agent blocks until every card is answered.

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

## Pairing

Until the package is published, build and run the checked-out shim directly:

```sh
vp run build:shim
node "$PWD/shim/dist/yepnope-mcp.cjs" pair ABC234 --label craig-mbp
```

Generate the six-character code in the app first; it expires after ten
minutes. Once the package is published, the equivalent command will be:

```sh
npx yepnope-mcp pair ABC234 --label craig-mbp
```

The label names the machine's token in the app so it can be revoked later; it
defaults to the hostname. New machine credentials have one canonical form:
`ynp_live_` followed by 43 unpadded base64url characters encoding 32 random
bytes (256 bits). Without another option, the command shows the credential once
as an `export YEPNOPE_TOKEN=...` line.

For an operator-safe MCP setup, capture the one-time credential in an exclusive
owner-readable file instead of printing it to a terminal or shared command log:

```sh
npx yepnope-mcp pair ABC234 --label craig-mbp \
  --token-file "$HOME/.config/yepnope/machine-token"
claude mcp add yepnope --scope local \
  --env YEPNOPE_TOKEN_FILE="$HOME/.config/yepnope/machine-token" -- \
  npx yepnope-mcp
```

The pairing command creates the token file with mode `0600` and refuses to
overwrite an existing file. The MCP shim reads either `YEPNOPE_TOKEN` or
`YEPNOPE_TOKEN_FILE`, never both. An existing machine credential remains valid;
the server stores only its SHA-256 hash and does not need a plaintext migration.
If a successful claim leaves an unusable or orphaned machine, open `/settings`
in the app and revoke its machine entry before pairing again.

## Hook install (Claude Code)

The Worker itself is the permission hook: no npm package, no local process.
Pair a machine to get a token, export it as `YEPNOPE_TOKEN`, and add this to
`settings.json`. The HTTP hook requires an environment value; do not put the
credential in the hook URL or commit it to the settings file:

```json
{
	"hooks": {
		"PermissionRequest": [
			{
				"hooks": [
					{
						"type": "http",
						"url": "https://yepnope.app/api/v1/hook",
						"headers": {"Authorization": "Bearer $YEPNOPE_TOKEN"},
						"allowedEnvVars": ["YEPNOPE_TOKEN"]
					}
				]
			}
		],
		"PreToolUse": [
			{
				"matcher": "AskUserQuestion",
				"hooks": [
					{
						"type": "http",
						"url": "https://yepnope.app/api/v1/hook",
						"headers": {"Authorization": "Bearer $YEPNOPE_TOKEN"},
						"allowedEnvVars": ["YEPNOPE_TOKEN"]
					}
				]
			}
		]
	}
}
```

While AFK mode is on (the default, toggled in the app), permission prompts
become swipe cards and `AskUserQuestion` is redirected to `ask_yep_nope`. While
it is off, both hooks abstain and everything runs natively. Hook decisions do
not bypass permission rules, and the default ten-minute hook timeout means an
abandoned card falls through to the terminal prompt.

## MCP install (`ask_yep_nope`)

The stdio MCP shim gives any harness the `ask_yep_nope` tool: stack any number
of yes/no questions, they land on the phone as one notification, and the call
blocks until every card is swiped. Pair a machine to get a token, then register
the shim. The token-file pairing path above is preferred because neither command
prints or embeds the credential. For an environment-based Claude Code setup:

```sh
claude mcp add yepnope --scope local --env YEPNOPE_TOKEN=ynp_live_... -- \
  node "$PWD/shim/dist/yepnope-mcp.cjs"
```

Codex supports the same local stdio server. Use an absolute path so the shim
continues to start when the harness changes directories:

```toml
# .codex/config.toml (trusted projects only; keep the token out of version control)
[mcp_servers.yepnope]
command = "node"
args = ["/absolute/path/to/yepnope/shim/dist/yepnope-mcp.cjs"]
tool_timeout_sec = 43200

[mcp_servers.yepnope.env]
YEPNOPE_TOKEN_FILE = "/absolute/path/to/.config/yepnope/machine-token"
```

The call may block for hours by design. The shim emits an MCP progress
notification every 15 seconds, and harnesses that implement progress
notifications reset their tool timeout on each one, so the wait survives. For
harnesses that time the call out anyway, raise the timeout explicitly — in
Claude Code set `MCP_TOOL_TIMEOUT` (milliseconds, e.g. `MCP_TOOL_TIMEOUT=43200000`
for 12 hours) in the environment; other harnesses have equivalents.

While the call blocks, the shim heartbeats the server over the answer stream.
If the agent process dies, the heartbeats stop, the server retracts the batch,
and the cards disappear from the phone; a resumed agent simply asks again.

While AFK mode is off, the remote OAuth MCP returns a structured native-fallback
result. The legacy shim returns a tool error with the same instruction. The shim
also keeps a local yes-rate count on disk (`~/.yepnope/telemetry.json`): when the
user answers yep to more than 95% of recent questions, the tool response starts
coaching the model to ask less.

## AFK mode and optional status output

The app toggle is the primary AFK control because it remains available after
you leave your computer. The CLI provides the same global per-user control for
when you are leaving deliberately:

```sh
npx yepnope-mcp afk          # show the current state
npx yepnope-mcp afk on       # route new questions to YepNope
npx yepnope-mcp afk off      # use native prompts for new questions
```

Changes apply to the next question only. Turning AFK mode off does not retract
cards already on the phone or strand agents waiting for those answers.

`npx yepnope-mcp afk statusline` is a one-shot command that prints `📱 YepNope:
ON` or `💻 YepNope: OFF`; configuration and server failures produce a warning
without printing the token. It does not start the MCP server or install a
timer.

YepNope must not create or replace a project or user `statusLine`. To make
composition discoverable while leaving the status line under its owner's
control, expose the one-shot command as `YEPNOPE_STATUSLINE_COMMAND`. This
repository does that without defining `statusLine`:

```json
{
	"env": {
		"YEPNOPE_STATUSLINE_COMMAND": "npx yepnope-mcp afk statusline"
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

3. Redeploy with `npm run deploy`, then confirm the provider is advertised:

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

### Passkeys and emailed sign-in links

Both are enabled unconditionally and need no secrets. Passkeys are bound to the
relying party derived from `BETTER_AUTH_URL`, so changing that hostname
invalidates every registered passkey. Emailed sign-in links expire in 15
minutes, are stored only as a hash, and are delivered through the same
Cloudflare `send_email` binding as verification and password-reset mail.

### Verifying a deployment

After each deploy, exercise every advertised method against production once:
sign in with email and password, request an emailed link and follow it,
register and then use a passkey, and complete each configured provider's
round trip. `/api/v1/auth-methods` is the checklist — every `true` and every
listed provider needs one pass.

## Privacy and retention

YepNope can read question bodies and answers stored by the service. End-to-end
encryption is not part of the MVP. Question bodies and answers are deleted seven
days after each batch is created. Content-free counters are retained after that
content is deleted.

## Development

```sh
just install   # install toolchain and dependencies
just dev       # run the dev server
just verify    # format, lint, typecheck, build, test
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
