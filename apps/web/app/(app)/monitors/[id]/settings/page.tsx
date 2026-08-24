import { notFound } from "next/navigation";
import { parseMonitorConfig } from "@socialmonitor/shared";
import { requireUser } from "../../../../../lib/supabase/server";
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
