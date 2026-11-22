import type { Config } from "@netlify/functions";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CORS, originOf } from "../lib/http.js";
import { unseal } from "../lib/seal.js";
import { buildServer } from "../lib/tools.js";

export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const origin = originOf(req);
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const grant = await unseal<{ bm: string; u: string }>("access", bearer);
  if (!grant) {
    return new Response(JSON.stringify({ error: "invalid_token", error_description: "Connect your Beeminder account first" }), {
      status: 401,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${bearer ? ', error="invalid_token"' : ""}`,
      },
    });
  }

  // Stateless JSON-only server: a GET would open an SSE stream a function can't hold open.
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });

  const server = buildServer(grant.bm, grant.u);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
};

export const config: Config = {
  path: "/mcp",
  rateLimit: { windowLimit: 300, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
