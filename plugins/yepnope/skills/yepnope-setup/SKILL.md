---
name: yepnope-setup
description: Inspect, connect, and authenticate the YepNope remote MCP server without permanent bearer-token setup or status-line takeover. Use when YepNope is missing, disconnected, unauthenticated, or the yepnope skill recommends setup.
---

# Set up YepNope

## Inspect without exposing credentials

Run the client-appropriate read-only checks:

- Claude Code: `claude mcp list`
- Codex:

    ```sh
    codex plugin list --json
    codex mcp list --json
    ```

Inspect only the `yepnope` entry. Never print configuration files, OAuth storage, request headers, or configured environment values. Never run `claude mcp get yepnope`, because it may print configured environment values.

Setup is complete only when the remote server is enabled, connected, authenticated with OAuth, and exposes `ask_yep_nope`.

## Keep Codex installation sources exclusive

When `yepnope@yepnope` is installed and enabled, its bundled MCP server is authoritative. Never run `codex mcp add yepnope` for that installation.

Detect a top-level registration without printing Codex configuration by checking only for the exact table header that `codex mcp add yepnope` creates:

```sh
codex_config_file="${CODEX_HOME:-$HOME/.codex}/config.toml"
rg --quiet '^[[:space:]]*\[mcp_servers\.yepnope\][[:space:]]*$' "$codex_config_file"
```

Exit status zero means a top-level registration is shadowing the bundled server. Show the conflict and get explicit approval before running `codex mcp remove yepnope`. Then confirm that the exact table header is absent and run the ordinary `codex mcp list --json` again. The bundled `yepnope` entry must remain present with `https://yepnope.app/mcp` and `tool_timeout_sec` equal to `691200`. If it does not, stop and report the failed verification; do not recreate a top-level entry.

## Connect Claude Code

If no `yepnope` server exists, run:

```sh
claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp
```

Then tell the user to run `/mcp`, select `yepnope`, and complete browser authentication. Do not remove or overwrite an existing server with the same name without showing the conflict and receiving confirmation.

## Connect Codex

If `yepnope@yepnope` is installed and enabled, resolve any shadowing top-level registration as described above, then run `codex mcp login yepnope`. Do not add another server.

Only when the plugin is not installed and no `yepnope` server exists, run:

```sh
codex mcp add yepnope --url https://yepnope.app/mcp
```

Then run `codex mcp login yepnope` and let the user complete browser authentication. If the plugin is not installed but a `yepnope` server already exists, keep it and proceed to login rather than adding it again. Do not remove or overwrite an existing server with the same name without showing the conflict and receiving confirmation.

## Verify once and return control

Treat the client command as authoritative for the OAuth result. A blank loopback callback tab does not establish whether authentication succeeded or failed. If the login command succeeds, continue with verification. If it fails or times out, report that exact result and stop; do not retry authentication automatically.

Verify the client reports the remote server as connected and OAuth-authenticated, then confirm through client tool discovery that `ask_yep_nope` is available. Never invoke `ask_yep_nope` as a connectivity test: it creates a real question and blocks while waiting for a human answer.

After reporting the verification result, end the turn and return control to the user. Do not resume the workflow that led to setup, deliver a pending question or approval, or invoke another YepNope skill or tool. Continue that earlier workflow only after the user sends a new message.

## Verify the Claude Code blocking-call budget

`ask_yep_nope` holds a single call open until a human answers, which can take hours. Claude Code aborts a tool call that has gone silent longer than its idle budget, and the default is roughly five minutes. The bundled `.mcp.json` ships `"timeout": 691200000` so that abort never happens, but an older installed copy of the plugin may predate the key, and verification that only checks connection and OAuth will call that install healthy.

Check the installed bundle without printing it:

```sh
rg --quiet '"timeout": 691200000' "${CLAUDE_PLUGIN_ROOT:?}/.mcp.json"
```

A nonzero exit status means blocking questions will be cut short after about five minutes. Report that the install is too old to hold a question open and ask the user to update the plugin. Do not edit the file and do not set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` on their behalf; the per-server key belongs to the shipped bundle.

Losing this race is destructive rather than merely slow. When the client gives up first it sends `notifications/cancelled`, the server retracts the batch, and the cards vanish off the phone mid-answer while the agent collects a timeout instead of a decision.

## Name the app-side routing precondition

A connected, authenticated server is not sufficient for phone delivery. Questions reach the phone only while phone routing is on in the YepNope app, and that switch belongs to the app alone.

So when reporting a successful setup, add one sentence: questions reach the phone only while phone routing is on in the YepNope app, and while it is off `ask_yep_nope` returns `route: native` with `reason: afk_off` and the question is asked in the client instead. That is a working setup answering honestly, not a setup failure, and it is the state a user who has never opened the app is in.

State it once as information and stop. Do not read routing state, do not turn it on for the user, and do not ask them to. The prohibition above still holds: never invoke `ask_yep_nope` to discover the state, because a call that does route to the phone creates a real question and blocks until a human answers it.

## Keep status output optional

Never create or replace a `statusLine` setting. If the user wants to compose YepNope into an existing Claude Code status line, point them to `YEPNOPE_STATUSLINE_COMMAND`. The status-line owner decides whether and when to invoke it. Never add `refreshInterval` for YepNope.
