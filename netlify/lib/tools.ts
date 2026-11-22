import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Beeminder, summarizeDatapoint, summarizeGoal } from "./beeminder.js";

const slug = z.string().min(1).describe("Goal slug, the short name in the goal's URL (e.g. 'exercise')");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

export function buildServer(token: string, username: string) {
  const bm = new Beeminder(token);
  const goalUrl = (s: string) => `https://www.beeminder.com/${encodeURIComponent(username)}/${encodeURIComponent(s)}`;
  const goal = (g: any) => ({ ...summarizeGoal(g), url: goalUrl(g.slug) });
  const g = (s: string) => `/users/me/goals/${encodeURIComponent(s)}`;

  const server = new McpServer(
    { name: "beeminder", version: "1.0.0" },
    {
      instructions:
        "Tools for the user's Beeminder account. Beeminder goals derail (and charge the pledge) when the safety buffer runs out. " +
        "Use list_goals to see what's urgent. Before adding, editing or deleting datapoints, or ratcheting a goal, make sure the user intends it. " +
        "Datapoint dates are Beeminder 'daystamps' (YYYYMMDD) in the user's Beeminder timezone; omit to use today.",
    },
  );

  server.registerTool(
    "get_user",
    {
      title: "Get Beeminder user",
      description: "Get the connected Beeminder user's profile: username, timezone, deadline settings and goal slugs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async () => {
      const u: any = await bm.me();
      return {
        username: u.username,
        timezone: u.timezone,
        deadline_offset_seconds: u.deadline,
        goals: u.goals,
        urgency_load: u.urgency_load,
        subscription: u.subscription ?? null,
        updated_at: u.updated_at ? new Date(u.updated_at * 1000).toISOString() : null,
      };
    }),
  );

  server.registerTool(
    "list_goals",
    {
      title: "List goals",
      description:
        "List the user's active Beeminder goals, most urgent first, with safety buffer, what's due and when each derails.",
      inputSchema: {
        urgent_within_days: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only return goals whose safety buffer is at most this many days (0 = due today)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ urgent_within_days }: { urgent_within_days?: number }) => {
      const goals: any[] = await bm.call("GET", "/users/me/goals.json");
      let out = goals.map(goal).sort((a, b) => (a.derails_at ?? "").localeCompare(b.derails_at ?? ""));
      if (urgent_within_days !== undefined) out = out.filter((x) => (x.safety_buffer_days ?? 99) <= urgent_within_days);
      return { count: out.length, goals: out };
    }),
  );

  server.registerTool(
    "get_goal",
    {
      title: "Get goal",
      description: "Get one goal's details, optionally with its most recent datapoints.",
      inputSchema: {
        slug,
        recent_datapoints: z.number().int().min(0).max(100).optional().describe("How many recent datapoints to include (default 0)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ slug, recent_datapoints }: { slug: string; recent_datapoints?: number }) => {
      const data: any = await bm.call("GET", `${g(slug)}.json`, { datapoints: false });
      const result: any = { ...goal(data), description: data.fineprint || null, deadline_offset_seconds: data.deadline };
      if (recent_datapoints) {
        const dps: any[] = await bm.call("GET", `${g(slug)}/datapoints.json`, { sort: "timestamp", count: recent_datapoints });
        result.recent_datapoints = dps.map(summarizeDatapoint);
      }
      return result;
    }),
  );

  server.registerTool(
    "list_datapoints",
    {
      title: "List datapoints",
      description: "List a goal's datapoints, newest first.",
      inputSchema: {
        slug,
        count: z.number().int().min(1).max(500).optional().describe("Max datapoints to return (default 25)"),
        page: z.number().int().min(1).optional().describe("Page number when paging through history (1-based)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ slug, count, page }: { slug: string; count?: number; page?: number }) => {
      const per = count ?? 25;
      const params: Record<string, unknown> = { sort: "timestamp" };
      if (page) Object.assign(params, { page, per });
      else params.count = per;
      const dps: any[] = await bm.call("GET", `${g(slug)}/datapoints.json`, params);
      return { slug, count: dps.length, datapoints: dps.map(summarizeDatapoint) };
    }),
  );

  server.registerTool(
    "add_datapoint",
    {
      title: "Add datapoint",
      description:
        "Add a datapoint to a goal (e.g. log 30 minutes, 1 workout, a weight). Pass requestid to make retries safe: the same requestid never creates a duplicate.",
      inputSchema: {
        slug,
        value: z.number().describe("The datapoint value"),
        comment: z.string().max(500).optional().describe("Optional comment shown on the datapoint"),
        daystamp: z.string().regex(/^\d{8}$/).optional().describe("Day it counts for, YYYYMMDD. Omit for today."),
        requestid: z.string().max(100).optional().describe("Idempotency key, e.g. a UUID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async (a: { slug: string; value: number; comment?: string; daystamp?: string; requestid?: string }) => {
      const dp = await bm.call("POST", `${g(a.slug)}/datapoints.json`, {
        value: a.value,
        comment: a.comment ?? "via Claude",
        daystamp: a.daystamp,
        requestid: a.requestid,
      });
      return { added: summarizeDatapoint(dp), goal_url: goalUrl(a.slug) };
    }),
  );

  server.registerTool(
    "update_datapoint",
    {
      title: "Update datapoint",
      description: "Change the value, comment or day of an existing datapoint. Get ids from list_datapoints.",
      inputSchema: {
        slug,
        id: z.string().describe("Datapoint id"),
        value: z.number().optional(),
        comment: z.string().max(500).optional(),
        daystamp: z.string().regex(/^\d{8}$/).optional().describe("YYYYMMDD"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a: { slug: string; id: string; value?: number; comment?: string; daystamp?: string }) => {
      const dp = await bm.call("PUT", `${g(a.slug)}/datapoints/${encodeURIComponent(a.id)}.json`, {
        value: a.value,
        comment: a.comment,
        daystamp: a.daystamp,
      });
      return { updated: summarizeDatapoint(dp) };
    }),
  );

  server.registerTool(
    "delete_datapoint",
    {
      title: "Delete datapoint",
      description: "Permanently delete a datapoint. Confirm with the user first.",
      inputSchema: { slug, id: z.string().describe("Datapoint id") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a: { slug: string; id: string }) => {
      const dp = await bm.call("DELETE", `${g(a.slug)}/datapoints/${encodeURIComponent(a.id)}.json`);
      return { deleted: summarizeDatapoint(dp) };
    }),
  );

  server.registerTool(
    "ratchet_goal",
    {
      title: "Ratchet goal",
      description:
        "Reduce a goal's safety buffer to the given number of days (makes the goal stricter; cannot add buffer). Confirm with the user first.",
      inputSchema: {
        slug,
        new_safety_days: z.number().int().min(0).describe("Days of safety buffer to keep. 0 makes it due today."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async (a: { slug: string; new_safety_days: number }) => {
      const res: any = await bm.call("POST", `${g(a.slug)}/ratchet.json`, {
        newsafety: a.new_safety_days,
        beemergency: a.new_safety_days === 0 ? true : undefined,
      });
      return { ratcheted: res && res.slug ? goal(res) : res };
    }),
  );

  server.registerTool(
    "refresh_goal",
    {
      title: "Refresh goal data",
      description:
        "Ask Beeminder to re-fetch data for an autodata goal (e.g. one synced from another app) and redraw its graph. Asynchronous; use sparingly.",
      inputSchema: { slug },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap(async ({ slug }: { slug: string }) => {
      const queued = await bm.call("GET", `${g(slug)}/refresh_graph.json`);
      return { slug, queued };
    }),
  );

  return server;
}
