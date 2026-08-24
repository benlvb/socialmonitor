import type { Db } from "@socialmonitor/db";
import { defangPromptMarkers } from "@socialmonitor/shared";

/**
 * /ask tool layer (D17): thin parameterized queries. The model never sees SQL.
 * Integers clamped, strings bound, row/char caps. All read-only.
 * Theme counters are LIFETIME cumulative (mergeTheme only grows them) — they
 * are labeled as such; weekly windows come from item-level aggregates.
 */

const clamp = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

const TEXT_CAP = 300;

export interface AskToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const ASK_TOOLS: AskToolDef[] = [
  {
    name: "monitor_pulse",
    description:
      "One-shot overview: volume by signal type and sentiment mix for the window, plus top themes active in the window (theme author/item counters are lifetime totals, labeled).",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "lookback window, 1-365 (default 30)" } },
      required: [],
    },
  },
  {
    name: "top_themes",
    description:
      "Top deduped themes last active in the window, ranked by lifetime unique authors (counters are lifetime totals, labeled). Optionally filter by signal_type or source.",
    input_schema: {
      type: "object",
      properties: {
        signal_type: { type: "string" },
        source: { type: "string" },
        days: { type: "integer" },
        limit: { type: "integer", description: "1-25, default 10" },
      },
      required: [],
    },
  },
  {
    name: "volume_trend",
    description: "Daily item counts per source over the period.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "1-90, default 14" } },
      required: [],
    },
  },
  {
    name: "drilldown_items",
    description: "Verbatim items behind a theme description (exact match), with links.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string" },
        signal_type: { type: "string" },
        description: { type: "string" },
        limit: { type: "integer", description: "1-20, default 10" },
      },
      required: ["signal_type", "description"],
    },
  },
];

export async function runAskTool(
  sql: Db,
  monitorId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "monitor_pulse": {
      const days = clamp(args.days, 30, 1, 365);
      const [byType, sentiment, themes] = await Promise.all([
        sql`
          select c.signal_type, count(*) as items
          from item_classifications c
          join raw_items r on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
          where c.monitor_id = ${monitorId} and r.posted_at >= now() - make_interval(days => ${days})
          group by 1 order by 2 desc`,
        sql`
          select c.sentiment, count(*) as items
          from item_classifications c
          join raw_items r on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
          where c.monitor_id = ${monitorId} and c.relevant and r.posted_at >= now() - make_interval(days => ${days})
          group by 1`,
        sql`
          select source, signal_type, description,
                 author_count as lifetime_author_count,
                 item_count as lifetime_item_count, score_avg
          from themes where monitor_id = ${monitorId}
            and last_seen >= (now() - make_interval(days => ${days}))::date
          order by author_count desc limit 12`,
      ]);
      return {
        days,
        volume_by_signal_type: byType,
        sentiment_mix: sentiment,
        top_themes_active_in_window: themes,
      };
    }
    case "top_themes": {
      const days = clamp(args.days, 30, 1, 365);
      const limit = clamp(args.limit, 10, 1, 25);
      const signalType = typeof args.signal_type === "string" ? args.signal_type : null;
      const source = typeof args.source === "string" ? args.source : null;
      return sql`
        select source, signal_type, description, tags,
               author_count as lifetime_author_count,
               item_count as lifetime_item_count, score_avg,
               first_seen, last_seen, item_refs -> 0 ->> 'url' as sample_url
        from themes
        where monitor_id = ${monitorId}
          and last_seen >= (now() - make_interval(days => ${days}))::date
          and (${signalType}::text is null or signal_type = ${signalType})
          and (${source}::text is null or source = ${source})
        order by author_count desc limit ${limit}`;
    }
    case "volume_trend": {
      const days = clamp(args.days, 14, 1, 90);
      return sql`
        select posted_at::date as day, source, count(*) as items
        from raw_items
        where monitor_id = ${monitorId} and posted_at >= now() - make_interval(days => ${days})
        group by 1, 2 order by 1, 2`;
    }
    case "drilldown_items": {
      const limit = clamp(args.limit, 10, 1, 20);
      const source = typeof args.source === "string" ? args.source : null;
      const signalType = String(args.signal_type ?? "");
      const description = String(args.description ?? "");
      const rows = await sql`
        select r.source, left(r.content, ${TEXT_CAP}) as content, r.url, r.author_handle,
               r.posted_at, r.impressions, r.engagement
        from item_classifications c
        join raw_items r on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
        where c.monitor_id = ${monitorId}
          and c.signal_type = ${signalType} and c.description = ${description}
          and (${source}::text is null or c.source = ${source})
        order by coalesce(r.impressions, r.engagement, 0) desc
        limit ${limit}`;
      // Defang scraped text before it re-enters a prompt as tool_result data.
      return rows.map((r) => ({ ...r, content: defangPromptMarkers(r.content as string) }));
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

/** Precomputed digest (SPEC section 7): answers most questions without a tool call. */
export async function buildDigest(sql: Db, monitorId: string): Promise<unknown> {
  const [pulse, complaints, requests, trend] = await Promise.all([
    runAskTool(sql, monitorId, "monitor_pulse", { days: 30 }),
    runAskTool(sql, monitorId, "top_themes", { signal_type: "complaint", days: 30, limit: 10 }),
    runAskTool(sql, monitorId, "top_themes", { signal_type: "feature_request", days: 30, limit: 10 }),
    runAskTool(sql, monitorId, "volume_trend", { days: 14 }),
  ]);
  return {
    pulse_30d: pulse,
    top_complaints_30d: complaints,
    top_feature_requests_30d: requests,
    volume_trend_14d: trend,
  };
}
