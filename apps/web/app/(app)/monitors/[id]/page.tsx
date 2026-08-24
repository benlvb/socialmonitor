import Link from "next/link";
import { notFound } from "next/navigation";
import { NO_IMPRESSION_SOURCES, SOURCES, type Source } from "@socialmonitor/shared";
import { requireUser } from "../../../../lib/supabase/server";
import { runNow, resetBreaker } from "./ops-actions";
import { SentimentChart, VolumeChart, type SentimentPoint, type VolumePoint } from "../../../../components/charts";

export const dynamic = "force-dynamic";

export default async function MonitorDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireUser();
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name, status, config")
    .eq("id", id)
    .single();
  if (!monitor) notFound();

  const since7d = new Date(Date.now() - 7 * 864e5).toISOString();
  const [volumeRes, sentimentRes, themesRes, streamsRes, eventsRes, usageRes, items7dRes, relevant7dRes, classified7dRes] =
    await Promise.all([
      supabase.rpc("dashboard_volume", { p_monitor: id, p_days: 30 }),
      supabase.rpc("dashboard_sentiment", { p_monitor: id, p_days: 30 }),
      supabase
        .from("themes")
        .select("source, signal_type, description, tags, author_count, item_count, score_avg, last_seen")
        .eq("monitor_id", id)
        .gte("last_seen", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10))
        .order("author_count", { ascending: false })
        .limit(15),
      supabase
        .from("sync_streams")
        .select("source, stream, cursor, consecutive_failures, breaker_tripped_at, last_run_at, last_success_at, rows_total")
        .eq("monitor_id", id)
        .order("source"),
      supabase
        .from("pipeline_events")
        .select("level, kind, message, source, created_at")
        .eq("monitor_id", id)
        .order("created_at", { ascending: false })
        .limit(15),
      supabase.from("llm_usage").select("day, calls, cost_usd").eq("monitor_id", id)
        .gte("day", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)),
      supabase.from("raw_items").select("*", { count: "exact", head: true }).eq("monitor_id", id).gte("fetched_at", since7d),
      supabase.from("item_classifications").select("*", { count: "exact", head: true }).eq("monitor_id", id).eq("relevant", true).gte("classified_at", since7d),
      supabase.from("item_classifications").select("*", { count: "exact", head: true }).eq("monitor_id", id).gte("classified_at", since7d),
    ]);

  // Volume pivot: day rows with one key per source.
  const volumeMap = new Map<string, VolumePoint>();
  const sourcesPresent = new Set<Source>();
  for (const r of (volumeRes.data ?? []) as { day: string; source: Source; items: number }[]) {
    sourcesPresent.add(r.source);
    const row = volumeMap.get(r.day) ?? { day: r.day };
    row[r.source] = Number(r.items);
    volumeMap.set(r.day, row);
  }
  const volume = [...volumeMap.values()];

  const sentimentMap = new Map<string, SentimentPoint>();
  for (const r of (sentimentRes.data ?? []) as { day: string; sentiment: string; items: number }[]) {
    const row = sentimentMap.get(r.day) ?? { day: r.day, positive: 0, negative: 0, neutral: 0 };
    if (r.sentiment === "positive") row.positive += Number(r.items);
    else if (r.sentiment === "negative" || r.sentiment === "mixed") row.negative += Number(r.items);
    else row.neutral += Number(r.items);
    sentimentMap.set(r.day, row);
  }
  const sentiment = [...sentimentMap.values()];

  const usage = usageRes.data ?? [];
  const monthCost = usage.reduce((s, u) => s + Number(u.cost_usd), 0);
  const todayCalls = usage.find((u) => u.day === new Date().toISOString().slice(0, 10))?.calls ?? 0;
  const config = monitor.config as { budgets?: { daily_classifications?: number } };
  const dailyBudget = config.budgets?.daily_classifications ?? 500;

  const items7d = items7dRes.count ?? 0;
  const classified7d = classified7dRes.count ?? 0;
  const relevant7d = relevant7dRes.count ?? 0;
  const relevantRate = classified7d > 0 ? Math.round((relevant7d / classified7d) * 100) : null;

  const streams = streamsRes.data ?? [];
  const events = eventsRes.data ?? [];

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1>{monitor.name}</h1>
        <span className={`pill ${monitor.status === "active" ? "ok" : "idle"}`}>{monitor.status}</span>
        <div className="spacer" />
        <form action={runNow.bind(null, id)} style={{ display: "inline" }}>
          <button type="submit">Run now</button>
        </form>
        <Link className="btn" href={`/monitors/${id}/ask`}>Ask</Link>
        <Link className="btn" href={`/monitors/${id}/items`}>Items</Link>
        <Link className="btn" href={`/monitors/${id}/summaries`}>Summaries</Link>
        <Link className="btn" href={`/monitors/${id}/settings`}>Settings</Link>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <span className="label">Items · 7d</span>
          <span className="value">{items7d}</span>
        </div>
        <div className="card stat">
          <span className="label">Relevant rate · 7d</span>
          <span className="value">{relevantRate === null ? "—" : `${relevantRate}%`}</span>
          <span className="hint">{relevant7d} of {classified7d} classified</span>
        </div>
        <div className="card stat">
          <span className="label">Classification budget · today</span>
          <span className="value">{todayCalls}/{dailyBudget}</span>
        </div>
        <div className="card stat">
          <span className="label">LLM spend · 30d</span>
          <span className="value">${monthCost.toFixed(2)}</span>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Volume by source · 30d</h2>
          <VolumeChart data={volume} sources={[...sourcesPresent]} />
        </div>
        <div className="card">
          <h2>Sentiment of relevant items · 30d</h2>
          <SentimentChart data={sentiment} />
        </div>
      </div>

      <div className="card">
        <h2>Top themes · 30d (ranked by unique authors)</h2>
        {(themesRes.data ?? []).length === 0 ? (
          <p className="muted">No themes yet — they appear once classification runs.</p>
        ) : (
          <table className="data">
            <thead>
              <tr><th>Theme</th><th>Type</th><th>Tags</th><th>Authors</th><th>Items</th><th>Score</th><th>Source</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              {themesRes.data!.map((t) => (
                <tr key={`${t.source}:${t.signal_type}:${t.description}`}>
                  <td>
                    <Link href={`/monitors/${id}/items?source=${t.source}&signal_type=${t.signal_type}&description=${encodeURIComponent(t.description)}`}>
                      {t.description}
                    </Link>
                  </td>
                  <td>{t.signal_type}</td>
                  <td>{(t.tags as string[]).join(", ")}</td>
                  <td>{t.author_count}</td>
                  <td>{t.item_count}</td>
                  <td>{t.score_avg ?? "—"}</td>
                  <td>{t.source}</td>
                  <td>{t.last_seen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Pipeline health</h2>
          {streams.length === 0 ? (
            <p className="muted">No streams yet — they appear on the first pipeline tick.</p>
          ) : (
            <table className="data">
              <thead>
                <tr><th>Stream</th><th>State</th><th>Last success</th><th>Rows</th></tr>
              </thead>
              <tbody>
                {streams.map((s) => {
                  const state = s.breaker_tripped_at
                    ? (
                        <form action={resetBreaker.bind(null, id, s.source, s.stream)} style={{ display: "inline" }}>
                          <span className="pill err">breaker</span>{" "}
                          <button type="submit" style={{ padding: "1px 8px", fontSize: 11 }}>Reset</button>
                        </form>
                      )
                    : s.consecutive_failures > 0
                      ? <span className="pill warn">{s.consecutive_failures} fail(s)</span>
                      : <span className="pill ok">ok</span>;
                  return (
                    <tr key={`${s.source}/${s.stream}`}>
                      <td className="mono">{s.source}/{s.stream}</td>
                      <td>{state}</td>
                      <td>{s.last_success_at ? new Date(s.last_success_at).toLocaleString() : "never"}</td>
                      <td>{s.rows_total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="field-hint" style={{ marginTop: 8 }}>
            Reach note: {SOURCES.filter((s) => NO_IMPRESSION_SOURCES.includes(s)).join(", ")} have no
            view counts — dashboards show engagement/follower reach for them, never mixed silently
            with impressions.
          </p>
        </div>
        <div className="card">
          <h2>Recent events</h2>
          {events.length === 0 ? (
            <p className="muted">Quiet.</p>
          ) : (
            <table className="data">
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`pill ${e.level === "error" ? "err" : e.level === "warn" ? "warn" : "idle"}`}>
                        {e.kind}
                      </span>
                    </td>
                    <td>{e.message}</td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
