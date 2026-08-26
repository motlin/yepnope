---
name: yepnope
description: Route every user-facing yes-or-no question through YepNope before any native question flow. Use whenever the agent may ask the user a question, when checking whether YepNope is connected, or when setup may be missing or expired.
---

# YepNope

## Try YepNope first

Before asking the user any question, determine whether the needed input can be expressed as one or more independent yes-or-no decisions. If it can, call `ask_yep_nope` first for every decision. Do this regardless of how small, obvious, or inexpensive the decision seems. Do not default to the client's native question flow.

Do not read or cache AFK state separately. The `ask_yep_nope` call atomically reads the app-controlled routing state for each question.

If `ask_yep_nope` is unavailable before the first attempted call in a session, run at most one read-only client check:

- In Claude Code, run `claude mcp list` and inspect only the `yepnope` status. Never run `claude mcp get yepnope`, because it may print configured environment values.
- In Codex, run `codex mcp list` and inspect only the `yepnope` status and authentication mode.

If YepNope is absent, disconnected, or requires authentication, use the client's native question flow after that failed attempt. Recommend `/yepnope-setup` in Claude Code or `$yepnope-setup` in Codex after the immediate question is handled.

## Fall back narrowly

If the tool returns `route: native` with `reason: afk_off`, immediately ask the same question through the client's native user-question flow. This is the normal state-based fallback. Do not ask the user to turn routing on and do not change routing from the agent.

If the attempted tool call fails because the connection became unavailable, use the same native fallback. If the tool returns Yep, Nope, or Skip, honor that disposition and do not ask the question again natively.

Preserve the user's exact decision boundary. The phone receives only the `title`, `body`, and context chips passed in the `ask_yep_nope` call; it cannot see the terminal, chat transcript, or text printed before the call. Copy every exact item needed for the decision into the body even when it already appears elsewhere. For commit approval, include each short SHA and subject. Do not use phrases such as “listed above,” “as discussed,” “these commits,” or “previous message” as a substitute for the details. If the facts do not fit in one card, split them into independent yes-or-no decisions rather than referring to external context.

Fill in the `repo`, `branch`, `worktree`, and `directory` arguments whenever the session is inside a git repository. Derive them from the shell rather than asking the user, and omit any you cannot determine. They render as chips on the card, and they are how the user tells one of your sessions from another when several worktrees of the same repository are open at once.

Use the native question flow for input that cannot be represented truthfully as yes or no, including open-ended input, credentials, secrets, and choices that require more than two answers. Do not force those requests into a misleading binary question.

## Preserve client ownership

Never install a timer, background poll, session hook, or project-owned status line. Never edit `statusLine` settings.

When the user has opted into status-line composition, use the existing `YEPNOPE_STATUSLINE_COMMAND` value. Do not create it globally or execute it repeatedly in the background.
