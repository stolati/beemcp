// OAuth 2.1 authorization server for MCP clients (Claude, Claude Code, Cursor…),
// bridged to Beeminder's own OAuth. Fully stateless: see lib/seal.ts.
//
//  Claude ──/authorize──▶ consent page ──▶ beeminder.com/apps/authorize
//         ◀──code────────  /oauth/callback ◀──access_token── Beeminder
//  Claude ──/token (PKCE)──▶ access_token (sealed Beeminder token) ──▶ /mcp
import type { Config } from "@netlify/functions";
import { registerClient, redirectMatches, resolveClient, validRedirectUri } from "../lib/clients.js";
import { CORS, esc, getCookie, html, json, oauthError, originOf, page, readParams, redirect } from "../lib/http.js";
import { Beeminder, BeeminderError } from "../lib/beeminder.js";
import { redact } from "../lib/activity.js";
import { now, seal, sha256b64url, unseal } from "../lib/seal.js";

const ACCESS_TTL = 60 * 60 * 24 * 30; // 30 days; refresh tokens don't expire (Beeminder tokens don't either)
const CLAUDE_HOSTS = ["claude.ai", "claude.com"];

interface Pending {
  cid: string; // client_id
  cn: string; // client name
  ru: string; // redirect_uri
  cc: string; // PKCE code_challenge
  st?: string; // client state
  sc?: string; // scope
  rs?: string; // resource
  nonce: string; // CSRF binding with the consent cookie
}
interface Grant {
  bm: string; // Beeminder access token
  u: string; // Beeminder username
  cid: string;
}

/** Structured Netlify function log line. Never pass tokens, codes or secrets here. */
function audit(event: string, data: Record<string, unknown> = {}) {
  console.log(redact(JSON.stringify({ at: new Date().toISOString(), event, ...data })));
}
const hostOf = (u: string) => {
  try {
    return new URL(u).host || new URL(u).protocol;
  } catch {
    return "invalid";
  }
};

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const origin = originOf(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["beeminder"],
          resource_name: "Beeminder",
          resource_documentation: origin,
        });

      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["beeminder"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
          service_documentation: origin,
        });

      case "/register":
        if (req.method !== "POST") return oauthError("invalid_request", "POST only", 405);
        return register(req);

      case "/authorize":
        return req.method === "POST" ? authorizePost(req, origin) : authorizeGet(url);

      case "/oauth/callback":
        return callback(req, url, origin);

      case "/token":
        if (req.method !== "POST") return oauthError("invalid_request", "POST only", 405);
        return token(req);

      case "/oauth/deauthorize":
        // Beeminder notifies us when a user removes the app. We store nothing, and the
        // revoked Beeminder token inside any sealed access token is now dead anyway.
        audit("beeminder_deauthorized");
        return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  } catch (e) {
    console.error(JSON.stringify({ route: url.pathname, error: redact(e instanceof Error ? e.message : String(e)) }));
    return oauthError("server_error", "Unexpected error", 500);
  }
};

async function register(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as any;
  if (!body || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10)
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array");
  for (const r of body.redirect_uris)
    if (typeof r !== "string" || !validRedirectUri(r)) return oauthError("invalid_redirect_uri", `Not allowed: ${r}`);
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none")
    return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported");
  const name = String(body.client_name ?? "MCP client").slice(0, 80);
  const client = await registerClient(name, body.redirect_uris);
  audit("client_registered", { client_name: name, redirect_hosts: body.redirect_uris.map(hostOf) });
  return json(
    {
      ...client,
      client_id_issued_at: now(),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

function errorPage(msg: string, status = 400) {
  return html(page("Can't connect", `<h1>Can't connect</h1><p>${esc(msg)}</p>`), status);
}

function backToClient(ru: string, params: Record<string, string | undefined>) {
  const u = new URL(ru);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return redirect(u.toString());
}

async function authorizeGet(url: URL): Promise<Response> {
  const q = url.searchParams;
  const client_id = q.get("client_id") ?? "";
  const ru = q.get("redirect_uri") ?? "";
  const client = client_id ? await resolveClient(client_id) : null;
  if (!client) audit("authorize_failed", { reason: "unknown_client", cimd: client_id.startsWith("https://") });
  if (!client) return errorPage("Unknown app (client_id). Try removing and re-adding the connector.");
  if (!ru || !redirectMatches(client.redirect_uris, ru)) audit("authorize_failed", { reason: "redirect_mismatch", client_name: client.client_name, redirect_host: hostOf(ru) });
  if (!ru || !redirectMatches(client.redirect_uris, ru)) return errorPage("This app's redirect address isn't registered.");

  const state = q.get("state") ?? undefined;
  const fail = (error: string, d: string) => (audit("authorize_failed", { reason: error, detail: d, client_name: client.client_name }), backToClient(ru, { error, error_description: d, state }));
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  const cc = q.get("code_challenge");
  if (!cc || (q.get("code_challenge_method") ?? "plain") !== "S256") return fail("invalid_request", "PKCE with S256 is required");
  if (!process.env.BEEMINDER_CLIENT_ID) return errorPage("Server is not configured (BEEMINDER_CLIENT_ID).", 500);

  const nonce = crypto.randomUUID();
  const scriptNonce = crypto.randomUUID().replace(/-/g, "");
  const pending: Pending = {
    cid: client.client_id,
    cn: client.client_name,
    ru,
    cc,
    st: state,
    sc: q.get("scope") ?? undefined,
    rs: q.get("resource") ?? undefined,
    nonce,
  };
  const p = await seal("pending", pending, 600);
  audit("consent_shown", { client_name: client.client_name, redirect_host: hostOf(ru) });
  const host = new URL(ru).host || new URL(ru).protocol;
  const isClaude = CLAUDE_HOSTS.includes(new URL(ru).hostname);

  const body = `
<h1>Connect Beeminder</h1>
<p>An app is asking to use your Beeminder account.</p>
<div class="who"><span class="dot"></span><div><b>${esc(client.client_name)}</b><br><small>will receive access at <code>${esc(host)}</code></small></div></div>
${isClaude ? "" : `<p class="warn">Only continue if you just added this connector yourself in that app.</p>`}
<p>It will be able to:</p>
<ul><li>read your goals and datapoints</li><li>add, edit and delete datapoints</li><li>ratchet goals and refresh autodata</li></ul>
<p>Next, Beeminder will ask you to approve. You can revoke access any time in Beeminder's account settings.</p>
<form method="post" action="/authorize">
<input type="hidden" name="p" value="${esc(p)}">
<div class="row"><button name="action" value="deny">Cancel</button><button class="primary" name="action" value="approve" autofocus>Continue to Beeminder</button></div>
<input type="hidden" name="action" value="">
<p id="status" class="small" role="status" aria-live="polite"></p>
</form>
<script nonce="${scriptNonce}">
// Lock the form after the first click so a double click can't submit twice.
// The chosen action goes in the hidden field because disabled buttons aren't submitted.
(function () {
  var form = document.querySelector("form"), sent = false;
  form.addEventListener("submit", function (e) {
    if (sent) { e.preventDefault(); return; }
    sent = true;
    var b = e.submitter, approve = b && b.value === "approve";
    form.querySelector('input[name="action"][type="hidden"]').value = b ? b.value : "approve";
    setTimeout(function () {
      form.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      if (approve) b.textContent = "Opening Beeminder…";
      document.getElementById("status").textContent = approve ? "Taking you to Beeminder to approve…" : "Cancelling…";
    }, 0);
  });
  // Coming back with the browser's Back button re-enables the form.
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    sent = false;
    form.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
    form.querySelector(".primary").textContent = "Continue to Beeminder";
    document.getElementById("status").textContent = "";
  });
})();
</script>`;
  return html(page("Connect Beeminder", body), 200, {
    "Set-Cookie": `bm_csrf=${nonce}; Path=/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  }, scriptNonce);
}

async function authorizePost(req: Request, origin: string): Promise<Response> {
  const form = await readParams(req);
  const pending = await unseal<Pending>("pending", form.get("p"));
  if (!pending) audit("consent_failed", { reason: "expired_or_invalid" });
  if (!pending) return errorPage("This sign-in link expired. Go back and try connecting again.");
  // CSRF: the Lax cookie set on GET is not sent on a cross-site POST.
  if (getCookie(req, "bm_csrf") !== pending.nonce) audit("consent_failed", { reason: "csrf_cookie_missing", client_name: pending.cn });
  if (getCookie(req, "bm_csrf") !== pending.nonce) return errorPage("Please start the connection again from your app.", 403);
  const reqOrigin = req.headers.get("origin");
  if (reqOrigin && reqOrigin !== "null" && reqOrigin !== origin) return errorPage("Cross-site request refused.", 403);

  const clearCsrf = "bm_csrf=; Path=/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  if (!form.getAll("action").includes("approve")) {
    audit("consent_denied", { client_name: pending.cn });
    const u = new URL(pending.ru);
    u.searchParams.set("error", "access_denied");
    if (pending.st) u.searchParams.set("state", pending.st);
    return redirect(u.toString(), { "Set-Cookie": clearCsrf }, 303);
  }

  audit("consent_approved", { client_name: pending.cn, redirect_host: hostOf(pending.ru) });
  const bmAuth = new URL("https://www.beeminder.com/apps/authorize");
  bmAuth.searchParams.set("client_id", process.env.BEEMINDER_CLIENT_ID!);
  bmAuth.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
  bmAuth.searchParams.set("response_type", "token");

  // The CSRF cookie is deliberately left to expire (10 min) rather than cleared here,
  // so a duplicate submit (double click, flaky network) is accepted instead of erroring.
  const headers = new Headers({ Location: bmAuth.toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", `bm_pending=${form.get("p")}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return new Response(null, { status: 303, headers });
}

async function callback(req: Request, url: URL, origin: string): Promise<Response> {
  const pending = await unseal<Pending>("pending", getCookie(req, "bm_pending"));
  if (!pending) audit("callback_failed", { reason: "pending_cookie_missing" });
  if (!pending) return errorPage("Your sign-in session expired or cookies are blocked. Start again from your app.");
  const clear = { "Set-Cookie": "bm_pending=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0" };
  const bm = url.searchParams.get("access_token");
  if (!bm) {
    audit("callback_failed", { reason: "beeminder_denied", client_name: pending.cn });
    const r = backToClient(pending.ru, { error: "access_denied", error_description: "Beeminder authorization was not granted", state: pending.st });
    r.headers.append("Set-Cookie", clear["Set-Cookie"]);
    return r;
  }
  let username = url.searchParams.get("username") ?? "";
  if (!username) {
    username = ((await new Beeminder(bm).me().catch(() => ({}))) as any).username ?? "";
  }
  audit("beeminder_authorized", { user: username || "unknown", client_name: pending.cn });
  const code = await seal("code", { bm, u: username, cid: pending.cid, ru: pending.ru, cc: pending.cc }, 120);
  const r = backToClient(pending.ru, { code, state: pending.st, iss: origin });
  r.headers.append("Set-Cookie", clear["Set-Cookie"]);
  return r;
}

async function issue(g: Grant): Promise<Response> {
  const access_token = await seal("access", g, ACCESS_TTL);
  const refresh_token = await seal("refresh", g);
  return json({ access_token, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token, scope: "beeminder" });
}

async function token(req: Request): Promise<Response> {
  const p = await readParams(req);
  const grant = p.get("grant_type");

  if (grant === "authorization_code") {
    const code = await unseal<Grant & { ru: string; cc: string }>("code", p.get("code"));
    if (!code) audit("token_failed", { grant, reason: "code_invalid_or_expired" });
    if (!code) return oauthError("invalid_grant", "Code is invalid or expired");
    if (p.get("client_id") && p.get("client_id") !== code.cid) return oauthError("invalid_grant", "client_id mismatch");
    if (p.get("redirect_uri") && p.get("redirect_uri") !== code.ru) return oauthError("invalid_grant", "redirect_uri mismatch");
    const verifier = p.get("code_verifier");
    if (!verifier || (await sha256b64url(verifier)) !== code.cc) audit("token_failed", { grant, reason: "pkce_mismatch", user: code.u });
    if (!verifier || (await sha256b64url(verifier)) !== code.cc) return oauthError("invalid_grant", "PKCE verification failed");
    audit("token_issued", { grant, user: code.u });
    return issue({ bm: code.bm, u: code.u, cid: code.cid });
  }

  if (grant === "refresh_token") {
    const rt = await unseal<Grant>("refresh", p.get("refresh_token"));
    if (!rt) audit("token_failed", { grant, reason: "refresh_invalid" });
    if (!rt) return oauthError("invalid_grant", "Refresh token is invalid");
    if (p.get("client_id") && p.get("client_id") !== rt.cid) return oauthError("invalid_grant", "client_id mismatch");
    // Confirm the Beeminder token still works (the user may have revoked the app).
    try {
      await new Beeminder(rt.bm).me();
    } catch (e) {
      if (e instanceof BeeminderError && (e.status === 401 || e.status === 403))
        return audit("token_failed", { grant, reason: "beeminder_revoked", user: rt.u }), oauthError("invalid_grant", "Beeminder access was revoked");
    }
    audit("token_issued", { grant, user: rt.u });
    return issue({ bm: rt.bm, u: rt.u, cid: rt.cid });
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

export const config: Config = {
  path: [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/register",
    "/authorize",
    "/oauth/callback",
    "/oauth/deauthorize",
    "/token",
  ],
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
