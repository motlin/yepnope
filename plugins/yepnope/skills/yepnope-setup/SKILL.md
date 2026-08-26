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

## Keep status output optional

Never create or replace a `statusLine` setting. If the user wants to compose YepNope into an existing Claude Code status line, point them to `YEPNOPE_STATUSLINE_COMMAND`. The status-line owner decides whether and when to invoke it. Never add `refreshInterval` for YepNope.
