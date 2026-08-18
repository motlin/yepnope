# Better Auth OAuth and remote MCP proof

This fixture records the local compatibility contract proven on 2026-08-18. It does not alter the production Worker or the legacy pairing path.

## Proven contract

- Codex CLI: `codex-cli 0.147.0`
- Better Auth, `@better-auth/mcp`, and `@better-auth/memory-adapter`: `1.7.0`
- MCP server SDK: `@modelcontextprotocol/server` `2.0.0`
- Compatibility client: `@modelcontextprotocol/sdk` `1.30.0`
- Local issuer: `http://127.0.0.1:<port>/api/auth`
- Local protected resource and Streamable HTTP endpoint: `http://127.0.0.1:<port>/mcp`
- Production shapes to retain in the implementation step: issuer `https://yepnope.app/api/auth` and resource `https://yepnope.app/mcp`
- Authorization metadata: `<issuer>/.well-known/oauth-authorization-server`
- Protected-resource metadata: `<origin>/.well-known/oauth-protected-resource`, with Better Auth also advertising the path form `<origin>/.well-known/oauth-protected-resource/mcp` in bearer challenges
- Scopes: `openid offline_access yepnope:questions`

The deterministic suite proves RFC 8414 and RFC 9728 discovery, Authorization Code with S256 PKCE, the RFC 8707 `resource` parameter, an access-token `aud` containing the exact MCP resource, scope enforcement, refresh rotation, and a protected tool call. It also proves failure for denied consent, a wrong audience, insufficient scope, an expired access token, replay of a rotated refresh token, and replay of a consumed authorization code.

The MCP server uses the v2 Web Standard Streamable HTTP transport. A dedicated workerd test proves the pinned SDK initializes with Cloudflare's `Request`, `Response`, and streams. The stateful transport keeps a long-running `ask_yep_nope` call open. Both the SDK client and Codex process cancellation reach the server handler's abort signal.

## Real Codex result

With the fixture on port `37891`, this registration completed discovery, browser authorization, PKCE exchange, and credential storage without a bearer-token environment variable:

```sh
codex mcp add yepnope-proof \
  --url http://127.0.0.1:37891/mcp \
  --oauth-resource http://127.0.0.1:37891/mcp
```

Codex opened a redirect shaped as `http://127.0.0.1:<ephemeral>/callback/4FAwZNJbSB0T`. Across repeated logins the port changed while the callback suffix remained stable for the MCP URL. A real `codex exec` called `protected_echo` and received the authenticated subject. Interrupting a real `ask_yep_nope` call produced `turn interrupted`, and the server observed cancellation.

## Client registration decision

Use Dynamic Client Registration for the current Codex 0.147 integration. It is the least-open mechanism that completes the normal `mcp add` flow without extra user configuration.

A configured fixed public client was also proven with `--oauth-client-id`, but only after forcing `mcp_oauth_callback_port` to the exact registered loopback redirect. `mcp add` does not persist that callback-port override, while default Codex logins choose a new ephemeral port, so the fixed client is not a reliable installation contract for this CLI version. Production DCR must therefore be narrowly configured and abuse-controlled in the provider implementation task.

Client ID Metadata Documents were not selected. Better Auth 1.7 supports CIMD through a companion package, and current Codex documentation describes CIMD, but the installed Codex 0.147 `mcp add` and `mcp login` help expose no client-registration metadata option. Re-evaluate CIMD when the deployed client baseline exposes and proves that path.

References: [Better Auth MCP](https://www.better-auth.com/docs/plugins/mcp), [MCP TypeScript SDK v2 serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/http), and [Codex MCP](https://developers.openai.com/codex/mcp/).

## Repeatable checks

```sh
vp test --run tests/oauth-mcp-proof/oauth-mcp-proof.test.ts
vp exec vitest run --config vitest.worker.config.ts worker/tests/oauth-mcp-sdk-compatibility.test.ts
```

For an explicit real-client smoke, run `vp run proof:oauth-mcp`, register the printed resource with the command above, call `protected_echo`, then interrupt `ask_yep_nope`. The browser pages contain only a local fake account and auto-approve solely to keep the proof executable; they are not production consent UX.
