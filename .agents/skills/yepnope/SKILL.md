---
name: yepnope
description: Check the YepNope MCP connection before routing brief yes-or-no questions to a phone. Use when an agent wants to call ask_yep_nope, when the user asks whether YepNope is connected, or when setup may be missing or expired.
---

# YepNope

## Check setup once

Before the first YepNope call in a session, check whether the `ask_yep_nope` MCP tool is available. Do not poll after this check.

If the tool is unavailable, run at most one read-only client check:

- In Claude Code, run `claude mcp list` and inspect only the `yepnope` status. Never run `claude mcp get yepnope`, because it may print configured environment values.
- In Codex, run `codex mcp list` and inspect only the `yepnope` status and authentication mode.

If YepNope is absent, disconnected, or requires authentication, do not attempt the question through YepNope. In Claude Code, recommend `/yepnope-setup`. In Codex, recommend `$yepnope-setup`. Use the client's native question flow if the user still needs to answer immediately.

## Route questions

Use `ask_yep_nope` only for brief, self-contained questions whose choices are genuinely yep or nope. Preserve the user's exact decision boundary and include enough context for the question to make sense on a phone.

Do not use YepNope for open-ended input, credentials, secrets, or choices that require more than two answers.

## Preserve client ownership

Never install a timer, background poll, session hook, or project-owned status line. Never edit `statusLine` settings.

When the user has opted into status-line composition, use the existing `YEPNOPE_STATUSLINE_COMMAND` value. Do not create it globally or execute it repeatedly in the background.
