---
name: yepnope
description: Route blocking yes-or-no questions through YepNope with native fallback. Use before asking a brief binary question, when checking whether YepNope is connected, or when setup may be missing or expired.
---

# YepNope

## Check setup once

Before the first YepNope call in a session, check whether the `ask_yep_nope` MCP tool is available. Do not poll after this check.

If the tool is unavailable, run at most one read-only client check:

- In Claude Code, run `claude mcp list` and inspect only the `yepnope` status. Never run `claude mcp get yepnope`, because it may print configured environment values.
- In Codex, run `codex mcp list` and inspect only the `yepnope` status and authentication mode.

If YepNope is absent, disconnected, or requires authentication, use the client's native question flow. Recommend `/yepnope-setup` in Claude Code or `$yepnope-setup` in Codex after the immediate question is handled.

## Route questions

Before using the client's native question flow for a blocking, genuinely binary decision, call `ask_yep_nope`. Do not read or cache AFK state separately. The tool atomically reads the app-controlled routing state for each call.

If the tool returns `route: native` with `reason: afk_off`, immediately ask the same question through the client's native question flow. Do not ask the user to turn routing on and do not change routing from the agent. If the tool call fails because the connection became unavailable, use the same native fallback.

Preserve the user's exact decision boundary and include enough context for the question to make sense on a phone.

Do not use YepNope for open-ended input, credentials, secrets, or choices that require more than two answers.

## Preserve client ownership

Never install a timer, background poll, session hook, or project-owned status line. Never edit `statusLine` settings.

When the user has opted into status-line composition, use the existing `YEPNOPE_STATUSLINE_COMMAND` value. Do not create it globally or execute it repeatedly in the background.
