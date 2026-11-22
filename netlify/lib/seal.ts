// Stateless "sealed" tokens: AES-256-GCM over a small JSON payload.
// Everything the server needs to remember (pending authorizations, auth codes,
// access/refresh tokens, registered clients) is encrypted into the value the
// client holds, so the server needs no database.

const enc = new TextEncoder();
const dec = new TextDecoder();

let keyPromise: Promise<CryptoKey> | null = null;

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const secret = process.env.TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error("TOKEN_SECRET env var missing or too short (use 32+ random chars)");
    }
    keyPromise = crypto.subtle
      .digest("SHA-256", enc.encode(secret))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return keyPromise;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export type SealType = "client" | "pending" | "code" | "access" | "refresh";

// Visible prefix per type, so you can tell values apart at a glance.
// (The type is also bound into the encryption, so one can never be used as another.)
const PREFIX: Record<SealType, string> = { client: "bmc_", pending: "bmp_", code: "bmo_", access: "bma_", refresh: "bmr_" };

export async function seal<T extends object>(typ: SealType, payload: T, ttlSeconds?: number): Promise<string> {
  const body = { ...payload, typ, iat: now(), ...(ttlSeconds ? { exp: now() + ttlSeconds } : {}) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(typ) }, await getKey(), enc.encode(JSON.stringify(body))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `${PREFIX[typ]}${b64url(out)}`;
}

export async function unseal<T>(typ: SealType, token: string | null | undefined): Promise<(T & { iat: number; exp?: number }) | null> {
  if (!token) return null;
  const prefix = PREFIX[typ];
  if (!token.startsWith(prefix)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length), "base64url");
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(typ) }, await getKey(), ct);
    const body = JSON.parse(dec.decode(pt));
    if (body.typ !== typ) return null;
    if (body.exp && body.exp < now()) return null;
    return body;
  } catch {
    return null;
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return b64url(new Uint8Array(digest));
}
