# YepNope

Swipe to answer your coding agent's yes/no questions.

Agents ask brief, self-contained questions through an MCP tool or the Claude Code
permission hook; the questions land on your phone as swipe cards. Right is yep,
left is nope, down is skip. The agent blocks until every card is answered.

## Hook install (Claude Code)

The Worker itself is the permission hook: no npm package, no local process. Pair
a machine to get a token, export it as `YEPNOPE_TOKEN`, and add this to
`settings.json`:

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

## Development

```sh
just install   # install toolchain and dependencies
just dev       # run the dev server
just verify    # format, lint, typecheck, build, test
```

Card layout mockups live in `mockups/index.html` — a self-contained page used to
measure title/body character limits at iPhone dimensions.
