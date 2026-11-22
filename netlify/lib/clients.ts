// OAuth client resolution: either a client we registered (DCR, sealed client_id)
// or a Client ID Metadata Document (client_id is an https URL we fetch).
import { seal, unseal } from "./seal.js";

export interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);

export function isLoopback(u: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export function validRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (BLOCKED_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "http:") return isLoopback(u);
  return true; // https, or a native app's custom scheme (cursor://, vscode://)
}

/** Exact match, except loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let c: URL;
  try {
    c = new URL(candidate);
  } catch {
    return false;
  }
  if (!isLoopback(c)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return isLoopback(u) && u.protocol === c.protocol && u.hostname === c.hostname && u.pathname === c.pathname;
    } catch {
      return false;
    }
  });
}

export async function registerClient(name: string, redirect_uris: string[]): Promise<Client> {
  const client_id = await seal("client", { n: name, r: redirect_uris });
  return { client_id, client_name: name, redirect_uris };
}

export async function resolveClient(client_id: string): Promise<Client | null> {
  if (client_id.startsWith("https://")) return fetchMetadataDocument(client_id);
  const c = await unseal<{ n: string; r: string[] }>("client", client_id);
  return c ? { client_id, client_name: c.n, redirect_uris: c.r } : null;
}

async function fetchMetadataDocument(url: string): Promise<Client | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // Basic SSRF guard: https only, a real hostname, no IP literals or internal names.
  if (u.protocol !== "https:" || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":") || !u.hostname.includes(".")) return null;
  if (/(^|\.)(localhost|internal|local)$/.test(u.hostname)) return null;
  try {
    const res = await fetch(u, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 64_000) return null;
    const doc = JSON.parse(text);
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return null;
    const redirect_uris = doc.redirect_uris.filter((r: unknown) => typeof r === "string" && validRedirectUri(r));
    if (!redirect_uris.length) return null;
    return { client_id: url, client_name: String(doc.client_name ?? u.hostname).slice(0, 80), redirect_uris };
  } catch {
    return null;
  }
}
