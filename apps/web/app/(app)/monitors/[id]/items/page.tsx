import Link from "next/link";
import { notFound } from "next/navigation";
import { NO_IMPRESSION_SOURCES, SOURCES, parseMonitorConfig, type Source } from "@socialmonitor/shared";
import { requireUser } from "../../../../../lib/supabase/server";
import { CorrectionForm } from "./correction-form";

export const dynamic = "force-dynamic";

export default async function ItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const { supabase } = await requireUser();
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name, config")
    .eq("id", id)
    .single();
  if (!monitor) notFound();
  const config = parseMonitorConfig(monitor.config);

  let q = supabase
    .from("item_classifications")
    .select("source, external_id, relevant, signal_type, sentiment, tags, score, description, reasoning, model, corrected, classified_at")
    .eq("monitor_id", id)
    .order("classified_at", { ascending: false })
    .limit(50);
  if (filters.source) q = q.eq("source", filters.source);
  if (filters.signal_type) q = q.eq("signal_type", filters.signal_type);
  if (filters.description) q = q.eq("description", filters.description);
  const { data: classifications } = await q;

  const keys = (classifications ?? []).map((c) => c.external_id);
  const { data: rawItems } = keys.length
    ? await supabase
        .from("raw_items")
        .select("source, external_id, url, author_handle, author_name, author_followers, content, posted_at, impressions, engagement")
        .eq("monitor_id", id)
        .in("external_id", keys)
    : { data: [] };
  const itemByKey = new Map((rawItems ?? []).map((r) => [`${r.source}:${r.external_id}`, r]));

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1>{monitor.name} — items</h1>
        <div className="spacer" />
        <Link className="btn" href={`/monitors/${id}`}>Dashboard</Link>
      </div>

      <form className="row card" method="get">
        <select name="source" defaultValue={filters.source ?? ""}>
          <option value="">all sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select name="signal_type" defaultValue={filters.signal_type ?? ""}>
          <option value="">all signal types</option>
          {config.signal_types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button>Filter</button>
        {filters.description && (
          <span className="pill idle">theme: {filters.description} <Link href={`/monitors/${id}/items`}>✕</Link></span>
        )}
      </form>

      {(classifications ?? []).length === 0 ? (
        <div className="card"><p className="muted">No classified items match.</p></div>
      ) : (
        (classifications ?? []).map((c) => {
          const item = itemByKey.get(`${c.source}:${c.external_id}`);
          const reachLabel = item
            ? item.impressions != null
              ? `${item.impressions.toLocaleString()} views`
              : NO_IMPRESSION_SOURCES.includes(c.source as Source)
                ? `reach proxy: ${item.engagement ?? 0} engagement${item.author_followers ? `, ${item.author_followers} followers` : ""}`
                : `${item.engagement ?? 0} engagement`
            : "";
          return (
            <div className="card" key={`${c.source}:${c.external_id}`}>
              <div className="row">
                <span className={`pill ${c.relevant ? "ok" : "idle"}`}>{c.signal_type}</span>
                <span className="pill idle">{c.sentiment}</span>
                {(c.tags as string[]).map((t) => (
                  <span className="pill idle" key={t}>{t}</span>
                ))}
                {c.corrected && <span className="pill warn">corrected</span>}
                <div className="spacer" />
                <span className="muted">{c.source} · {c.model}</span>
              </div>
              <p style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{item?.content ?? "(raw item purged)"}</p>
              <p className="muted" style={{ fontSize: 12 }}>
                {item?.author_name || item?.author_handle}
                {item?.posted_at ? ` · ${new Date(item.posted_at).toLocaleString()}` : ""}
                {reachLabel ? ` · ${reachLabel}` : ""}
                {item?.url ? (
                  <> · <a href={item.url} target="_blank" rel="noreferrer">original ↗</a></>
                ) : null}
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                <b>why:</b> {c.reasoning} {c.description ? <>· <b>theme:</b> {c.description}</> : null}
              </p>
              <CorrectionForm
                monitorId={id}
                source={c.source}
                externalId={c.external_id}
                signalTypes={config.signal_types}
                current={{
                  relevant: c.relevant,
                  signal_type: c.signal_type,
                  sentiment: c.sentiment,
                  tags: c.tags as string[],
                  score: c.score,
                  description: c.description,
                }}
              />
            </div>
          );
        })
      )}
    </>
  );
}
