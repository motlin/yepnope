# YepNope

Swipe to answer your coding agent's yes/no questions.

Agents ask brief, self-contained questions through an MCP tool or the Claude Code
permission hook; the questions land on your phone as swipe cards. Right is yep,
left is nope, down is skip. The agent blocks until every card is answered.

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

While AFK mode is off, `ask_yep_nope` returns a tool error telling the model to
use its native question tool instead. The shim also keeps a local yes-rate
count on disk (`~/.yepnope/telemetry.json`): when the user answers yep to more
than 95% of recent questions, the tool response starts coaching the model to
ask less.

## AFK mode and Claude Code statusline

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

Claude Code can display the server state in its status line. Export
`YEPNOPE_TOKEN` in the environment that launches Claude Code, then add this to
`~/.claude/settings.json` (or project settings):

```json
{
	"statusLine": {
		"type": "command",
		"command": "npx yepnope-mcp afk statusline",
		"refreshInterval": 10
	}
}
```

The command reads the live server state and prints `📱 YepNope: ON` or
`💻 YepNope: OFF`; configuration and server failures produce a warning without
printing the token. It ignores Claude Code's session JSON on stdin and exits
without starting the MCP server. `YEPNOPE_URL` overrides the service URL for
development. See Claude Code's official
[statusline documentation](https://code.claude.com/docs/en/statusline) for
composition with an existing status line and other settings.

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
