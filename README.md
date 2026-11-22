# BeeMCP: Beeminder for Claude

A remote MCP server for [Beeminder](https://www.beeminder.com). Users paste one URL (`https://beemcp.dev/mcp`) into Claude, approve on Beeminder, and they're done. There are no API keys to copy and no database to run.

## How it works

```
Claude ──► /mcp (401 + resource metadata)
       ──► /.well-known/oauth-authorization-server
       ──► /register            (Dynamic Client Registration, or a Client ID Metadata Document URL)
       ──► /authorize           consent page: "Claude wants access to your Beeminder"
                └─► beeminder.com/apps/authorize ──► /oauth/callback?access_token=…
       ◄── redirect with ?code  (auth code = sealed Beeminder token, 2 min TTL)
       ──► /token  (PKCE S256)  ► access_token (30 days) + refresh_token
       ──► /mcp  Bearer …       ► Beeminder API
```

- **Stateless.** Every artifact (client_id, pending request, code, access and refresh tokens) is AES-256-GCM-encrypted JSON sealed with `TOKEN_SECRET`. No DB, no Blobs.
- **Confused-deputy safe.** Because any client can register, our own consent screen runs before Beeminder's (Beeminder may auto-approve repeat visits). The approve POST is CSRF-bound with a SameSite=Lax cookie and an Origin check. The page also can't be framed.
- **PKCE S256 required.** Public clients only.
- **Streamable HTTP, JSON responses.** Each request gets a fresh MCP server, which fits serverless.

Tools: `get_user`, `list_goals`, `get_goal`, `list_datapoints`, `add_datapoint`, `update_datapoint`, `delete_datapoint`, `ratchet_goal`, `refresh_goal`.

## Deploy on Netlify

1. **Register a Beeminder app** at <https://www.beeminder.com/apps/new>:
   - Redirect URL: `https://YOUR_DOMAIN/oauth/callback` (it must match exactly)
   - Post de-authorization callback (optional): `https://YOUR_DOMAIN/oauth/deauthorize`
   - Copy the **client ID**.
2. **Create the Netlify site** from this repo (build settings come from `netlify.toml`).
3. **Set environment variables** (Site configuration → Environment variables):
   | Var | Value |
   |---|---|
   | `BEEMINDER_CLIENT_ID` | from step 1 |
   | `TOKEN_SECRET` | `openssl rand -hex 32`. Changing it signs everyone out. |
   | `PUBLIC_BASE_URL` | optional, e.g. `https://beemcp.dev`. Pins the OAuth issuer if you serve several hostnames. |
4. **Add the custom domain** (Domain management) and let Netlify provision HTTPS.
5. In Claude: Settings → Connectors → Add custom connector → `https://YOUR_DOMAIN/mcp`.

Beeminder allows only one redirect URL per app, so deploy previews can't complete sign-in. Use a second Beeminder app for a staging site.

## Develop

```bash
npm install
npm run typecheck
npm test            # full OAuth + MCP flow against a mock Beeminder API
npx netlify dev     # local server at http://localhost:8888
npx @modelcontextprotocol/inspector   # point it at http://localhost:8888/mcp
```

## Known trade-offs

- Auth codes are single-use only within their 2-minute TTL. PKCE plus the TTL limits replay, but there's no stateless way to enforce one-time use. Add Netlify Blobs if you need it.
- Revocation happens through Beeminder: when a user revokes the app, every sealed token stops working on its next API call.
- Rate limits are set in each function's `config.rateLimit` (60/min OAuth, 300/min MCP, per IP).

Not affiliated with Beeminder.
