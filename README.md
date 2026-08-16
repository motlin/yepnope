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

## MCP install (`ask_yep_nope`)

The stdio MCP shim gives any harness the `ask_yep_nope` tool: stack any number
of yes/no questions, they land on the phone as one notification, and the call
blocks until every card is swiped. Pair a machine to get a token, then register
the shim. For Claude Code:

```sh
claude mcp add yepnope --env YEPNOPE_TOKEN=ynp_live_... -- npx yepnope-mcp
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

## Development

```sh
just install   # install toolchain and dependencies
just dev       # run the dev server
just verify    # format, lint, typecheck, build, test
```

Card layout mockups live in `mockups/index.html` — a self-contained page used to
measure title/body character limits at iPhone dimensions.
