// End-to-end test of the OAuth bridge + MCP tools against a mock Beeminder API.
// Run: npm test
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const BM_TOKEN = "bm-oauth-token-123";
const dps: any[] = [{ id: "dp1", daystamp: "20261121", value: 2, comment: "old", timestamp: 1763700000 }];
const mock = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  let body = "";
  for await (const c of req) body += c;
  const params = new URLSearchParams(body);
  const tok = url.searchParams.get("access_token") ?? params.get("access_token");
  res.setHeader("Content-Type", "application/json");
  if (tok !== BM_TOKEN) return res.writeHead(401).end(JSON.stringify({ errors: { token: "bad" } }));
  const p = url.pathname.replace("/api/v1", "");
  if (p === "/users/me.json") return res.end(JSON.stringify({ username: "mike", timezone: "America/Los_Angeles", goals: ["run", "read"], deadline: 0 }));
  if (p === "/users/me/goals.json")
    return res.end(JSON.stringify([
      { slug: "read", safebuf: 5, losedate: 1800000000, gunits: "pages", safesum: "safe for 5 days" },
      { slug: "run", safebuf: 0, losedate: 1764000000, gunits: "km", safesum: "due today", baremin: "+3" },
    ]));
  if (p === "/users/me/goals/run/datapoints.json" && req.method === "POST") {
    const dp = { id: "dp2", value: Number(params.get("value")), comment: params.get("comment"), daystamp: params.get("daystamp") ?? "20261122", timestamp: 1763800000 };
    dps.unshift(dp);
    return res.end(JSON.stringify(dp));
  }
  if (p === "/users/me/goals/run/datapoints.json") return res.end(JSON.stringify(dps));
  res.writeHead(404).end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((r) => mock.listen(0, r));
const port = (mock.address() as any).port;

process.env.TOKEN_SECRET = randomBytes(32).toString("hex");
process.env.BEEMINDER_CLIENT_ID = "test-client";
process.env.BEEMINDER_API_BASE = `http://127.0.0.1:${port}/api/v1`;
const oauth = (await import("../netlify/functions/oauth.ts")).default;
const mcp = (await import("../netlify/functions/mcp.ts")).default;

const O = "https://beemcp.test";
const call = (h: (r: Request) => Promise<Response>, path: string, init: RequestInit = {}) => h(new Request(O + path, init));
const cookieFrom = (r: Response, name: string) =>
  r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(name + "="))!;

// 1. Unauthenticated MCP request advertises the resource metadata
let r = await call(mcp, "/mcp", { method: "POST", body: "{}" });
assert.equal(r.status, 401);
assert.match(r.headers.get("www-authenticate")!, /resource_metadata="https:\/\/beemcp.test\/.well-known\/oauth-protected-resource\/mcp"/);
const prm = await (await call(oauth, "/.well-known/oauth-protected-resource/mcp")).json();
assert.equal(prm.authorization_servers[0], O);
const asm = await (await call(oauth, "/.well-known/oauth-authorization-server")).json();
assert.equal(asm.registration_endpoint, `${O}/register`);

// 2. Dynamic client registration
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
r = await call(oauth, "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
assert.equal(r.status, 201);
const { client_id } = await r.json();
r = await call(oauth, "/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }) });
assert.equal(r.status, 400, "non-loopback http redirect refused");

// 3. Authorize → consent page
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const q = new URLSearchParams({ client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
r = await call(oauth, `/authorize?${q}`);
assert.equal(r.status, 200);
const htmlBody = await r.text();
const p = htmlBody.match(/name="p" value="([^"]+)"/)![1];
const csrf = cookieFrom(r, "bm_csrf");
assert.equal(r.headers.get("x-frame-options"), "DENY");

// wrong redirect_uri is rejected without redirecting
r = await call(oauth, `/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.com/cb" })}`);
assert.equal(r.status, 400);

// 4. Approve without CSRF cookie (cross-site POST) fails; with cookie redirects to Beeminder
r = await call(oauth, "/authorize", { method: "POST", body: new URLSearchParams({ p, action: "approve" }) });
assert.equal(r.status, 403);
r = await call(oauth, "/authorize", { method: "POST", headers: { cookie: csrf, origin: O }, body: new URLSearchParams({ p, action: "approve" }) });
assert.equal(r.status, 303);
const bmUrl = new URL(r.headers.get("location")!);
assert.equal(bmUrl.origin + bmUrl.pathname, "https://www.beeminder.com/apps/authorize");
assert.equal(bmUrl.searchParams.get("redirect_uri"), `${O}/oauth/callback`);
const pendingCookie = cookieFrom(r, "bm_pending");

// 5. Beeminder redirects back with its token → we redirect to Claude with a code
r = await call(oauth, `/oauth/callback?access_token=${BM_TOKEN}&username=mike`, { headers: { cookie: pendingCookie } });
assert.equal(r.status, 302);
const back = new URL(r.headers.get("location")!);
assert.equal(back.origin + back.pathname, REDIRECT);
assert.equal(back.searchParams.get("state"), "xyz");
assert.equal(back.searchParams.get("iss"), O);
const code = back.searchParams.get("code")!;
assert.ok(!code.includes(BM_TOKEN), "Beeminder token is not visible in the code");

// 6. Token exchange: bad verifier fails, good one succeeds
const tokenReq = (v: string) =>
  call(oauth, "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: v }) });
assert.equal((await tokenReq("wrong")).status, 400);
r = await tokenReq(verifier);
assert.equal(r.status, 200);
const tok = await r.json();
assert.equal(tok.token_type, "Bearer");

// 7. Refresh
r = await call(oauth, "/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id }) });
assert.equal(r.status, 200);
const tok2 = await r.json();

// 8. MCP calls with the token
let id = 0;
const rpc = async (method: string, params: any = {}) => {
  const res = await call(mcp, "/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok2.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).result;
};
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
assert.equal(init.serverInfo.name, "beeminder");
const tools = (await rpc("tools/list")).tools.map((t: any) => t.name);
console.log("tools:", tools.join(", "));
const goals = JSON.parse((await rpc("tools/call", { name: "list_goals", arguments: {} })).content[0].text);
assert.equal(goals.goals[0].slug, "run", "most urgent first");
assert.equal(goals.goals[0].url, "https://www.beeminder.com/mike/run");
const urgent = JSON.parse((await rpc("tools/call", { name: "list_goals", arguments: { urgent_within_days: 0 } })).content[0].text);
assert.equal(urgent.count, 1);
const added = JSON.parse((await rpc("tools/call", { name: "add_datapoint", arguments: { slug: "run", value: 5, comment: "morning run" } })).content[0].text);
assert.equal(added.added.value, 5);
const listed = JSON.parse((await rpc("tools/call", { name: "list_datapoints", arguments: { slug: "run", count: 5 } })).content[0].text);
assert.equal(listed.count, 2);
const missing = await rpc("tools/call", { name: "get_goal", arguments: { slug: "nope" } });
assert.equal(missing.isError, true);

// 9. A tampered token is rejected
r = await call(mcp, "/mcp", { method: "POST", headers: { Authorization: `Bearer ${tok2.access_token.slice(0, -4)}AAAA` }, body: "{}" });
assert.equal(r.status, 401);

console.log("All e2e checks passed");
mock.close();
