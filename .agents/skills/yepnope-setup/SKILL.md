---
name: yepnope-setup
description: Inspect, connect, and authenticate the YepNope remote MCP server without permanent bearer-token setup or status-line takeover. Use when YepNope is missing, disconnected, unauthenticated, or the yepnope skill recommends setup.
---

# Set up YepNope

## Inspect without exposing credentials

Run one client-appropriate read-only check:

- Claude Code: `claude mcp list`
- Codex: `codex mcp list`

Inspect only the `yepnope` entry. Never print configuration files, OAuth storage, request headers, or configured environment values. Never run `claude mcp get yepnope`, because it may print configured environment values.

Setup is complete only when the remote server is enabled, connected, authenticated with OAuth, and exposes `ask_yep_nope`.

## Connect Claude Code

If no `yepnope` server exists, run:

```sh
claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp
```

Then tell the user to run `/mcp`, select `yepnope`, and complete browser authentication. Do not remove or overwrite an existing server with the same name without showing the conflict and receiving confirmation.

## Connect Codex

If no `yepnope` server exists, run:

```sh
codex mcp add yepnope --url https://yepnope.app/mcp
```

Then run `codex mcp login yepnope` and let the user complete browser authentication. Do not remove or overwrite an existing server with the same name without showing the conflict and receiving confirmation.

## Verify once

After authentication, verify the client reports the remote server as connected and OAuth-authenticated, then confirm that `ask_yep_nope` is available. Stop after that check; do not install monitoring or poll the server.

## Keep status output optional

Never create or replace a `statusLine` setting. If the user wants to compose YepNope into an existing Claude Code status line, point them to `YEPNOPE_STATUSLINE_COMMAND`. The status-line owner decides whether and when to invoke it. Never add `refreshInterval` for YepNope.
