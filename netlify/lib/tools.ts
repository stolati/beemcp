import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Activity, redact } from "./activity.js";
import { Beeminder, summarizeDatapoint, summarizeGoal } from "./beeminder.js";

const slug = z.string().min(1).describe("Goal slug, the short name in the goal's URL (e.g. 'exercise')");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

interface Ctx {
  bm: Beeminder;
  log: Activity;
}

export function buildServer(token: string, username: string) {
  // Each tool call gets its own activity log, streamed to the client as it happens.
  function wrap<A>(name: string, fn: (args: A, ctx: Ctx) => Promise<unknown>) {
    return async (args: A, extra: any) => {
      const log = new Activity(name, username, extra, [token]);
      const bm = new Beeminder(token, log.apiHook);
      await log.info(`Started ${name}`, args && typeof args === "object" && Object.keys(args).length ? { args } : undefined);
      try {
        const result = await fn(args, { bm, log });
        await log.info(`Done in ${log.elapsedMs} ms`);
        return ok({ result, activity: log.steps });
      } catch (e) {
        const message = redact(e instanceof Error ? e.message : String(e), [token]);
        await log.error(`Failed: ${message}`);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, activity: log.steps }, null, 2) }] };
      }
    };
  }
  const goalUrl = (s: string) => `https://www.beeminder.com/${encodeURIComponent(username)}/${encodeURIComponent(s)}`;
  const goal = (g: any) => ({ ...summarizeGoal(g), url: goalUrl(g.slug) });
  const g = (s: string) => `/users/me/goals/${encodeURIComponent(s)}`;

  const server = new McpServer(
    { name: "beeminder", version: "1.1.0" },
    {
      capabilities: { logging: {} },
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
    wrap("get_user", async (_a: unknown, { bm, log }: Ctx) => {
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
    wrap("list_goals", async ({ urgent_within_days }: { urgent_within_days?: number }, { bm, log }: Ctx) => {
      const goals: any[] = await bm.call("GET", "/users/me/goals.json");
      const dueToday = goals.filter((x) => (x.safebuf ?? 99) <= 0).length;
      await log.info(`Found ${goals.length} goals, ${dueToday} due today`);
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
    wrap("get_goal", async ({ slug, recent_datapoints }: { slug: string; recent_datapoints?: number }, { bm, log }: Ctx) => {
      const data: any = await bm.call("GET", `${g(slug)}.json`, { datapoints: false });
      const result: any = { ...goal(data), description: data.fineprint || null, deadline_offset_seconds: data.deadline };
      if (recent_datapoints) {
        await log.info(`Fetching ${recent_datapoints} recent datapoints`);
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
    wrap("list_datapoints", async ({ slug, count, page }: { slug: string; count?: number; page?: number }, { bm, log }: Ctx) => {
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
    wrap("add_datapoint", async (a: { slug: string; value: number; comment?: string; daystamp?: string; requestid?: string }, { bm, log }: Ctx) => {
      await log.info(`Adding ${a.value} to "${a.slug}"${a.daystamp ? ` for ${a.daystamp}` : ""}`);
      const dp: any = await bm.call("POST", `${g(a.slug)}/datapoints.json`, {
        value: a.value,
        comment: a.comment ?? "via Claude",
        daystamp: a.daystamp,
        requestid: a.requestid,
      });
      await log.info(`Added datapoint ${dp?.id} to "${a.slug}"`);
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
    wrap("update_datapoint", async (a: { slug: string; id: string; value?: number; comment?: string; daystamp?: string }, { bm, log }: Ctx) => {
      await log.info(`Updating datapoint ${a.id} on "${a.slug}"`);
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
    wrap("delete_datapoint", async (a: { slug: string; id: string }, { bm, log }: Ctx) => {
      await log.warn(`Deleting datapoint ${a.id} from "${a.slug}"`);
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
    wrap("ratchet_goal", async (a: { slug: string; new_safety_days: number }, { bm, log }: Ctx) => {
      await log.warn(`Ratcheting "${a.slug}" to ${a.new_safety_days} day(s) of buffer`);
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
    wrap("refresh_goal", async ({ slug }: { slug: string }, { bm, log }: Ctx) => {
      const queued = await bm.call("GET", `${g(slug)}/refresh_graph.json`);
      await (queued ? log.info(`Refresh queued for "${slug}"`) : log.warn(`Beeminder did not queue a refresh for "${slug}"`));
      return { slug, queued };
    }),
  );

  return server;
}
