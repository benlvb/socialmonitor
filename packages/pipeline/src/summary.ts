import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@socialmonitor/db";
import { createAnthropic, DEFAULT_NARRATE_MODEL, estimateCostUsd } from "./classify/anthropic";
import { recordUsage, type MonitorRow } from "./db/repos";
import { logEvent } from "./events";
import { notify } from "./notify";

/**
 * Weekly summary (SPEC section 8, D19): Monday cron summarizes the week that
 * just ended (prev Mon..Sun) per monitor. Sonnet with a mandated section
 * structure so weeks stay comparable. Guards: truncation + empty-week skip.
 * Output: stored per (monitor, week_start), rendered on the dashboard, pushed
 * through the notifier.
 */

function lastWeekStart(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday=0
  d.setUTCDate(d.getUTCDate() - dow - 7);
  return d;
}

export async function runWeeklySummary(sql: Db, monitor: MonitorRow): Promise<void> {
  const start = lastWeekStart();
  const end = new Date(start.getTime() + 7 * 864e5);
  const prevStart = new Date(start.getTime() - 7 * 864e5);
  const weekKey = start.toISOString().slice(0, 10);

  const existing = await sql`
    select 1 from weekly_summaries where monitor_id = ${monitor.id} and week_start = ${weekKey}`;
  if (existing.length > 0) return; // idempotent per week

  const [byType, byTypePrev, bySource, sentiment, topThemes, topItems] = await Promise.all([
    sql`
      select c.signal_type, count(*) as n
      from item_classifications c
      join raw_items r on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
      where c.monitor_id = ${monitor.id} and r.posted_at >= ${start} and r.posted_at < ${end}
      group by 1 order by 2 desc`,
    sql`
      select c.signal_type, count(*) as n
      from item_classifications c
      join raw_items r on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
      where c.monitor_id = ${monitor.id} and r.posted_at >= ${prevStart} and r.posted_at < ${start}
      group by 1`,
    sql`
      select r.source, count(*) as n
      from raw_items r
      where r.monitor_id = ${monitor.id} and r.posted_at >= ${start} and r.posted_at < ${end}
      group by 1 order by 2 desc`,
    sql`
      select c.sentiment, count(*) as n
      from item_classifications c
      join raw_items r on r.monitor_id = c.monitor_id and r.source = c.source and r.external_id = c.external_id
      where c.monitor_id = ${monitor.id} and c.relevant and r.posted_at >= ${start} and r.posted_at < ${end}
      group by 1`,
    sql`
      select source, signal_type, description, tags, author_count, item_count, score_avg,
             item_refs -> 0 ->> 'url' as sample_url
      from themes
      where monitor_id = ${monitor.id} and last_seen >= ${weekKey}
      order by author_count desc limit 20`,
    sql`
      select r.source, r.content, r.url, r.author_handle, r.impressions, r.engagement
      from raw_items r
      join item_classifications c on c.monitor_id = r.monitor_id and c.source = r.source and c.external_id = r.external_id
      where r.monitor_id = ${monitor.id} and c.relevant and r.posted_at >= ${start} and r.posted_at < ${end}
      order by coalesce(r.impressions, r.engagement, 0) desc limit 5`,
  ]);

  const totalItems = bySource.reduce((s, r) => s + Number(r.n), 0);
  if (totalItems === 0) {
    console.log(`[summary] ${monitor.name}: empty week ${weekKey}, skipping`);
    return;
  }

  const client = createAnthropic();
  if (!client) {
    await logEvent(sql, {
      monitorId: monitor.id,
      level: "warn",
      kind: "summary_skipped",
      message: "weekly summary skipped: Anthropic not configured",
    });
    return;
  }

  const data = {
    monitor: monitor.name,
    context: monitor.config.context,
    week: { start: weekKey, end: end.toISOString().slice(0, 10) },
    volume_by_signal_type_this_week: byType,
    volume_by_signal_type_prior_week: byTypePrev,
    volume_by_source: bySource,
    sentiment_of_relevant_items: sentiment,
    top_themes_by_unique_authors: topThemes,
    highest_reach_items: topItems,
  };

  const prompt = `You are the insights analyst for the "${monitor.name}" monitor.
Write the weekly summary for the week ${weekKey} to ${data.week.end}.

## Structured data (the ONLY evidence you may use)
${JSON.stringify(data, null, 2)}

## Output requirements — write EXACTLY these sections:

# Weekly Summary — ${monitor.name}

## At-a-Glance
[One paragraph: total volume, breakdown by signal type, direction vs prior week.
Inline source tags like _[x]_, _[reddit]_.]

## Week-over-Week
| Signal type | This week | Last week | Delta |
|---|---|---|---|
[fill rows from the volume data; omit types with zero in both weeks]

## Key Themes
[3-6 narrative paragraphs grounded in top_themes_by_unique_authors and
highest_reach_items. Cite specific descriptions and author counts. Each
paragraph ends with: _Sample: [link](url)_ using sample_url/url values when present.]

## Recommendations
[3-7 numbered, imperative action items derived from the data.]

Do not invent data. If a section has thin evidence, say so briefly rather than padding.`;

  const model = monitor.config.model.narrate || DEFAULT_NARRATE_MODEL;
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const markdown = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const truncated = response.stop_reason === "max_tokens";

  await sql`
    insert into weekly_summaries (monitor_id, week_start, markdown, meta, generated_at)
    values (${monitor.id}, ${weekKey}, ${markdown},
            ${sql.json({ model, truncated, prompt_version: "v1", output_tokens: response.usage.output_tokens } as never)},
            now())
    on conflict (monitor_id, week_start) do update set
      markdown = excluded.markdown, meta = excluded.meta, generated_at = now()`;

  const cost = estimateCostUsd(model, response.usage as never, false);
  await recordUsage(sql, monitor.id, 1, response.usage.input_tokens, response.usage.output_tokens, cost);

  if (truncated) {
    await logEvent(sql, {
      monitorId: monitor.id,
      level: "error",
      kind: "summary_truncated",
      message: `weekly summary for ${weekKey} hit max_tokens — it may end mid-sentence`,
    });
  }

  await notify(`📊 Weekly summary — ${monitor.name} (week of ${weekKey})\n\n${markdown.slice(0, 3500)}${markdown.length > 3500 ? "\n…(full summary on the dashboard)" : ""}`);
  console.log(`[summary] ${monitor.name}: week ${weekKey} written (${markdown.length} chars, $${cost.toFixed(4)})`);
}
