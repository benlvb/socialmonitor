import { notFound } from "next/navigation";
import { parseMonitorConfig } from "@socialmonitor/shared";
import { requireUser } from "../../../../../lib/supabase/server";
import { backfill } from "../ops-actions";
import { SettingsForm } from "./settings-form";
import type { TargetRowInput } from "../../../../../components/targets-editor";

export const dynamic = "force-dynamic";

export default async function MonitorSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase } = await requireUser();
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id, name, status, config")
    .eq("id", id)
    .single();
  if (!monitor) notFound();

  const { data: targets } = await supabase
    .from("targets")
    .select("source, kind, value, enabled")
    .eq("monitor_id", id)
    .order("source");

  // Render the fully-defaulted config so every knob is visible and editable.
  const fullConfig = parseMonitorConfig(monitor.config);

  return (
    <>
      <h1>{monitor.name} — settings</h1>
      <div className="card">
        <h2>Backfill</h2>
        <p className="field-hint">
          Fetching is forward-only by default. This deliberately rewinds every fetch stream
          to pull history (idempotent - overlaps are safe; source budgets still apply).
          Per-source: X / Reddit / YouTube rewind by date and walk forward a page at a time;
          Discord rewinds every channel it has already synced; Telegram rewinds a bounded
          number of messages from its current position (and is skipped before its first sync).
        </p>
        <form action={backfill.bind(null, monitor.id)} className="row">
          <select name="days" defaultValue="7">
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>last {d} day{d > 1 ? "s" : ""}</option>
            ))}
          </select>
          <button type="submit">Backfill now</button>
        </form>
      </div>

      <SettingsForm
        monitorId={monitor.id}
        name={monitor.name}
        status={monitor.status}
        configJson={JSON.stringify(fullConfig, null, 2)}
        targets={(targets ?? []) as TargetRowInput[]}
      />
    </>
  );
}
