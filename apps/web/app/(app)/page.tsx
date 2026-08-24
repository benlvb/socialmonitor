import Link from "next/link";
import { requireUser } from "../../lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function MonitorsPage() {
  const { supabase } = await requireUser();
  const { data: monitors } = await supabase
    .from("monitors")
    .select("id, name, status, created_at")
    .order("created_at", { ascending: true });

  const { data: recentEvents } = await supabase
    .from("pipeline_events")
    .select("level")
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .eq("level", "error");

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1>Monitors</h1>
        <div className="spacer" />
        <Link className="btn primary" href="/monitors/new">New monitor</Link>
      </div>

      {(recentEvents?.length ?? 0) > 0 && (
        <div className="card">
          <span className="pill err">● {recentEvents!.length} pipeline error(s) in the last 24h</span>
        </div>
      )}

      {(monitors ?? []).length === 0 ? (
        <div className="card">
          <p>No monitors yet. Create one to define what to watch — platforms, accounts, keywords, and a taxonomy.</p>
        </div>
      ) : (
        <div className="grid cols-2">
          {monitors!.map((m) => (
            <div className="card" key={m.id}>
              <div className="row">
                <h2 style={{ margin: 0 }}>
                  <Link href={`/monitors/${m.id}`}>{m.name}</Link>
                </h2>
                <div className="spacer" />
                <span className={`pill ${m.status === "active" ? "ok" : "idle"}`}>{m.status}</span>
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>
                <Link href={`/monitors/${m.id}`}>dashboard</Link>
                {" · "}
                <Link href={`/monitors/${m.id}/items`}>items</Link>
                {" · "}
                <Link href={`/monitors/${m.id}/summaries`}>summaries</Link>
                {" · "}
                <Link href={`/monitors/${m.id}/settings`}>settings</Link>
              </p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
