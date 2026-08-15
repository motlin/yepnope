# YepNope

Swipe to answer your coding agent's yes/no questions.

Agents ask brief, self-contained questions through an MCP tool or the Claude Code
permission hook; the questions land on your phone as swipe cards. Right is yep,
left is nope, down is skip. The agent blocks until every card is answered.

## Development

```sh
just install   # install toolchain and dependencies
just dev       # run the dev server
just verify    # format, lint, typecheck, build, test
```

Card layout mockups live in `mockups/index.html` — a self-contained page used to
measure title/body character limits at iPhone dimensions.
