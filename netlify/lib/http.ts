export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}

export function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

export function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      ...extra,
    },
  });
}

export function redirect(location: string, extra: Record<string, string> = {}, status = 302): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra } });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function originOf(req: Request): string {
  return (process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
}

export async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") p.set(k, v);
    return p;
  }
  return new URLSearchParams(await req.text());
}

export function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--ink:#1d1a12;--muted:#6b6455;--bg:#fbf7ec;--card:#fff;--line:#e8dfc7;--bee:#f5b800;--go:#1d1a12}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;max-width:440px;width:100%;padding:32px;box-shadow:0 10px 30px -18px #3a2f0b55}
h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);margin:8px 0}
.who{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:12px;margin:18px 0;background:#fffdf6}
.who b{color:var(--ink)}code{font:13px ui-monospace,Menlo,monospace;background:#f3eddc;padding:2px 6px;border-radius:6px;word-break:break-all}
ul{padding-left:20px;color:var(--muted);margin:8px 0 18px}
.row{display:flex;gap:10px;margin-top:22px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:12px;border:1px solid var(--line);background:#fff;cursor:pointer}
button.primary{background:var(--go);color:#fff;border-color:var(--go)}.dot{width:12px;height:12px;border-radius:50%;background:var(--bee);flex:none}
.warn{color:#8a5a00;background:#fff4d6;border-radius:10px;padding:10px 12px;font-size:14px}
</style></head><body><main class="card">${inner}</main></body></html>`;
}
