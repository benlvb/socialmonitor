"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { validateMonitorConfig } from "@socialmonitor/shared";
import { requireUser } from "../../../lib/supabase/server";
import { templateConfig } from "../../../lib/monitor-templates";

export interface MonitorFormState {
  error?: string;
  issues?: string[];
  message?: string;
}

export async function createMonitor(
  _prev: MonitorFormState,
  formData: FormData,
): Promise<MonitorFormState> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Not signed in." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };
  const config = templateConfig(String(formData.get("template") ?? "blank"));

  const { data, error } = await supabase
    .from("monitors")
    .insert({ owner_id: user.id, name, status: "active", config })
    .select("id")
    .single();
  if (error) return { error: error.message };
  redirect(`/monitors/${data.id}/settings`);
}

interface TargetInput {
  source: string;
  kind: string;
  value: string;
  enabled: boolean;
}

export async function updateMonitor(
  monitorId: string,
  _prev: MonitorFormState,
  formData: FormData,
): Promise<MonitorFormState> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  const status = String(formData.get("status") ?? "active");
  const configRaw = String(formData.get("config") ?? "{}");
  const targetsRaw = String(formData.get("targets") ?? "[]");

  let configJson: unknown;
  try {
    configJson = JSON.parse(configRaw);
  } catch {
    return { error: "Config is not valid JSON." };
  }
  const validated = validateMonitorConfig(configJson);
  if (!validated.ok) return { error: "Config failed validation.", issues: validated.issues };

  let targets: TargetInput[];
  try {
    targets = JSON.parse(targetsRaw) as TargetInput[];
  } catch {
    return { error: "Targets payload malformed." };
  }

  const { error } = await supabase
    .from("monitors")
    .update({ name, status, config: configJson })
    .eq("id", monitorId);
  if (error) return { error: error.message };

  // Replace targets (RLS guarantees ownership).
  const { error: delError } = await supabase.from("targets").delete().eq("monitor_id", monitorId);
  if (delError) return { error: delError.message };
  const rows = targets
    .filter((t) => t.value.trim())
    .map((t) => ({
      monitor_id: monitorId,
      source: t.source,
      kind: t.kind,
      value: t.value.trim(),
      enabled: t.enabled,
      config: {},
    }));
  if (rows.length > 0) {
    const { error: insError } = await supabase.from("targets").insert(rows);
    if (insError) return { error: insError.message };
  }

  revalidatePath(`/monitors/${monitorId}/settings`);
  return { message: "Saved. The pipeline picks changes up on its next tick — no deploy needed." };
}

export async function deleteMonitor(monitorId: string): Promise<void> {
  const { supabase, user } = await requireUser();
  if (!user) return;
  await supabase.from("monitors").delete().eq("id", monitorId);
  redirect("/");
}
