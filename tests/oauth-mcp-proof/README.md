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

## Where YepNope's surfaces stop

Verified 2026-08-20 with `codex-cli 0.148.0` against this fixture on port `37891`, driving a real `codex mcp login`.

The browser sequence is authorize, then the authorization server's own sign-in page, then its consent page, then a redirect to the loopback redirect URI Codex registered for this login. That redirect carries `code`, `iss`, and `state` to `http://127.0.0.1:<ephemeral-port>/callback/<stable-suffix>`, and the response comes from Codex:

```http
HTTP/1.1 200 OK
Server: tiny-http (Rust)
Content-Type: text/plain; charset=UTF-8
Content-Length: 51

Authentication complete. You may close this window.
```

That page is not HTML, is not served by YepNope, and carries no YepNope-controlled bytes. The string is compiled into the Codex binary next to `rmcp-client/src/perform_oauth_login.rs`. YepNope cannot brand or style it, and must not try: substituting a YepNope page, or bouncing through one, would move the authorization code off the exact registered redirect and break PKCE and state validation for no user-visible gain.

The last surface YepNope owns is `/oauth/consent`. After a decision it renders `OAuthHandoffPanel`, which names the client, says whether the connection was authorized or declined, and tells the user they can close the tab. It renders while the browser is already navigating to the client's callback, so it adds no delay to code delivery. `tests/browser/oauth-consent-layout.spec.ts` covers both surfaces at desktop and narrow-phone sizes.

The redirect target and callback response above were confirmed against this local fixture. The production authorization server issues the same redirect shape, and the callback response is produced entirely by the local Codex process, so it does not vary by authorization server.

### Smallest actionable upstream request

Codex answers its own callback with `200 text/plain` and no `Cache-Control`, and leaves the authorization code and state in the browser's address bar and history. A minimal upstream change would send `Cache-Control: no-store` on that response and return a small HTML body that calls `history.replaceState` to drop the query string. Neither touches the protocol, the redirect URI, nor the timing of the code exchange.

## Repeatable checks

```sh
vp test --run tests/oauth-mcp-proof/oauth-mcp-proof.test.ts
vp exec vitest run --config vitest.worker.config.ts worker/tests/oauth-mcp-sdk-compatibility.test.ts
```

For an explicit real-client smoke, run `vp run proof:oauth-mcp`, register the printed resource with the command above, call `protected_echo`, then interrupt `ask_yep_nope`. The browser pages contain only a local fake account and auto-approve solely to keep the proof executable; they are not production consent UX.
