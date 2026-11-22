// Thin Beeminder API client (https://api.beeminder.com/).

const BASE = process.env.BEEMINDER_API_BASE ?? "https://www.beeminder.com/api/v1";

export class BeeminderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Beeminder {
  constructor(private accessToken: string) {}

  async call<T = any>(method: string, path: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(BASE + path);
    const form = new URLSearchParams();
    const all: Record<string, unknown> = { ...params, access_token: this.accessToken };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined || v === null) continue;
      if (method === "GET" || method === "DELETE") url.searchParams.set(k, String(v));
      else form.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/x-www-form-urlencoded" },
      body: method === "GET" || method === "DELETE" ? undefined : form,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg =
        (data && typeof data === "object" && (data.errors ? JSON.stringify(data.errors) : data.error)) ||
        (typeof data === "string" ? data.slice(0, 300) : `HTTP ${res.status}`);
      throw new BeeminderError(res.status, `Beeminder API ${res.status}: ${msg}`);
    }
    return data as T;
  }

  me() {
    return this.call("GET", "/users/me.json");
  }
}

const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);

/** Keep the fields that matter to a conversation; Beeminder goal objects are huge. */
export function summarizeGoal(g: any) {
  return {
    slug: g.slug,
    title: g.title || null,
    goal_type: g.goal_type,
    units: g.gunits,
    rate: g.rate,
    rate_unit: g.runits,
    current_value: g.curval,
    goal_value: g.goalval,
    goal_date: iso(g.goaldate),
    safety_buffer_days: g.safebuf,
    status: g.safesum,
    due: g.limsum,
    bare_min: g.baremin,
    derails_at: iso(g.losedate),
    has_data_today: g.todayta ?? null,
    pledge_usd: g.pledge,
    color: g.roadstatuscolor,
    autodata: g.autodata || null,
    frozen: !!g.frozen,
    won: !!g.won,
    lost: !!g.lost,
    graph_url: g.graph_url,
    url: g.slug ? `https://www.beeminder.com/${encodeURIComponent(g.slug)}` : undefined,
  };
}

export function summarizeDatapoint(d: any) {
  return {
    id: d.id,
    daystamp: d.daystamp,
    value: d.value,
    comment: d.comment || "",
    timestamp: iso(d.timestamp),
    requestid: d.requestid ?? undefined,
  };
}
