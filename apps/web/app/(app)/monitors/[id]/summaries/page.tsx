import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import { requireUser } from "../../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SummariesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { id } = await params;
  const { week } = await searchParams;
  const { supabase } = await requireUser();
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name")
    .eq("id", id)
    .single();
  if (!monitor) notFound();

  const { data: summaries } = await supabase
    .from("weekly_summaries")
    .select("week_start, markdown, meta, generated_at")
    .eq("monitor_id", id)
    .order("week_start", { ascending: false })
    .limit(26);

  const selected = week
    ? (summaries ?? []).find((s) => s.week_start === week)
    : (summaries ?? [])[0];

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1>{monitor.name} — weekly summaries</h1>
        <div className="spacer" />
        <Link className="btn" href={`/monitors/${id}`}>Dashboard</Link>
      </div>

      {(summaries ?? []).length === 0 ? (
        <div className="card">
          <p className="muted">
            No summaries yet — they generate every Monday once the pipeline is active (and appear
            in the Telegram channel too).
          </p>
        </div>
      ) : (
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="card" style={{ width: 190, flexShrink: 0 }}>
            {(summaries ?? []).map((s) => (
              <p key={s.week_start} style={{ margin: "4px 0" }}>
                <Link
                  href={`/monitors/${id}/summaries?week=${s.week_start}`}
                  style={{ fontWeight: s.week_start === selected?.week_start ? 700 : 400 }}
                >
                  week of {s.week_start}
                </Link>
              </p>
            ))}
          </div>
          <div className="card" style={{ flex: 1 }}>
            {selected ? (
              <>
                {(selected.meta as { truncated?: boolean })?.truncated && (
                  <p className="error-text">⚠ this summary hit the token limit and may end mid-sentence</p>
                )}
                <article
                  // Summaries quote scraped social content — sanitize before injecting.
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(marked.parse(selected.markdown) as string),
                  }}
                />
              </>
            ) : (
              <p className="muted">Pick a week.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
