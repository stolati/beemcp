// Per-tool-call activity log. Each step is:
//  - streamed to the client as an MCP `notifications/message` (logging) event,
//  - streamed as `notifications/progress` when the client sent a progressToken,
//  - printed to the Netlify function log (no tokens, ever),
//  - and returned in the tool result's `activity` trail, so it also shows in
//    clients (like Claude) that display tool output but not log notifications.

type Level = "debug" | "info" | "notice" | "warning" | "error";

interface Extra {
  sendNotification: (n: any) => Promise<void>;
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
}

export interface Step {
  t_ms: number;
  level: Level;
  message: string;
}

// Anything that looks like a credential is masked before it leaves the function,
// even if Beeminder or a library echoes it back in an error message.
const SECRET_PATTERNS: RegExp[] = [
  /\bbm[a-z]_[A-Za-z0-9_-]{16,}/g, // our sealed tokens (access, refresh, code, client, pending)
  /(access_token|auth_token|refresh_token|code_verifier|client_secret|code)=([^&\s"']+)/gi,
  /\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/gi,
];

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, (_m, a?: string) => (a && /=/.test(_m) ? `${a}=[redacted]` : a && /bearer/i.test(a) ? `${a} [redacted]` : "[redacted]"));
  return out;
}

export class Activity {
  readonly steps: Step[] = [];
  private start = Date.now();
  private progress = 0;

  constructor(private tool: string, private user: string, private extra?: Extra, private secrets: string[] = []) {}

  async log(level: Level, rawMessage: string, rawData?: Record<string, unknown>) {
    const message = redact(rawMessage, this.secrets);
    const data = rawData ? (JSON.parse(redact(JSON.stringify(rawData), this.secrets)) as Record<string, unknown>) : undefined;
    const step = { t_ms: Date.now() - this.start, level, message };
    this.steps.push(step);
    console.log(JSON.stringify({ tool: this.tool, user: this.user, ...step, ...data }));
    if (!this.extra) return;
    try {
      await this.extra.sendNotification({
        method: "notifications/message",
        params: { level, logger: `beeminder.${this.tool}`, data: data ? { message, ...data } : message },
      });
      const token = this.extra._meta?.progressToken;
      if (token !== undefined) {
        await this.extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: ++this.progress, message },
        });
      }
    } catch {
      // A client that went away must not break the tool call.
    }
  }

  info(message: string, data?: Record<string, unknown>) {
    return this.log("info", message, data);
  }
  warn(message: string, data?: Record<string, unknown>) {
    return this.log("warning", message, data);
  }
  error(message: string, data?: Record<string, unknown>) {
    return this.log("error", message, data);
  }

  /** Hook for the Beeminder client: one line per API call with status and timing. */
  apiHook = (e: { method: string; path: string; status: number; ms: number }) =>
    this.log(e.status < 400 ? "debug" : "warning", `Beeminder ${e.method} ${e.path} → ${e.status} (${e.ms} ms)`);

  get elapsedMs() {
    return Date.now() - this.start;
  }
}
