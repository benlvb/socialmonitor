"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { validateMonitorConfig } from "@socialmonitor/shared";
import { createDb } from "@socialmonitor/db";
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

  // .select().single() is load-bearing (audit #7): a zero-row update returns
  // error: null under RLS, and the target replace below runs on the
  // RLS-bypassing service connection.
  const { data: owned, error } = await supabase
    .from("monitors")
    .update({ name, status, config: configJson })
    .eq("id", monitorId)
    .select("id")
    .single();
  if (error) return { error: error.message };
  if (!owned) return { error: "Monitor not found." };

  // Target rows are UPSERTED IN PLACE, never delete-then-recreate (audit #3):
  // a target's UUID is its stream identity (`search/<id>`, `guild/<id>`…), so
  // regenerating ids on an unrelated config edit resets every cursor and
  // silently drops one fetch-window of data on every source. Deduped and
  // transactional (audit #12); ownership verified above.
  const seen = new Set<string>();
  const rows = targets
    .filter((t) => t.value.trim())
    .map((t) => ({
      source: t.source,
      kind: t.kind,
      value: t.value.trim(),
      enabled: t.enabled,
    }))
    .filter((t) => {
      const key = `${t.source}:${t.kind}:${t.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const sqlDb = createDb();
  if (!sqlDb) return { error: "DATABASE_URL not configured on the web app." };
  try {
    await sqlDb.begin(async (tx) => {
      const keep: string[] = [];
      for (const r of rows) {
        const [row] = await tx`
          insert into targets (monitor_id, source, kind, value, enabled, config)
          values (${monitorId}, ${r.source}, ${r.kind}, ${r.value}, ${r.enabled}, ${"{}"}::jsonb)
          on conflict (monitor_id, source, kind, value)
          do update set enabled = excluded.enabled
          returning id`;
        keep.push(row!.id as string);
      }
      // Remove targets the operator deleted, and retire their stream state so
      // the health panel doesn't fill with permanently-stale rows.
      const removed = keep.length
        ? await tx`delete from targets where monitor_id = ${monitorId} and id <> all(${keep}::uuid[]) returning id`
        : await tx`delete from targets where monitor_id = ${monitorId} returning id`;
      for (const r of removed) {
        await tx`
          delete from sync_streams
          where monitor_id = ${monitorId} and stream like ${"%/" + (r.id as string)}`;
      }
    });
  } catch (err) {
    return { error: `Saving targets failed (nothing was changed): ${String(err)}` };
  } finally {
    await sqlDb.end({ timeout: 3 });
  }

  revalidatePath(`/monitors/${monitorId}/settings`);
  return { message: "Saved. The pipeline picks changes up on its next tick — no deploy needed." };
}

export async function deleteMonitor(monitorId: string): Promise<void> {
  const { supabase, user } = await requireUser();
  if (!user) return;
  // Ownership check first; the data tables carry no FK to monitors, so their
  // rows would otherwise linger forever, invisible under RLS (audit #17).
  const { data: owned } = await supabase
    .from("monitors")
    .select("id")
    .eq("id", monitorId)
    .single();
  if (!owned) return;

  const sqlDb = createDb();
  if (sqlDb) {
    try {
      await sqlDb.begin(async (tx) => {
        for (const table of [
          "raw_items",
          "item_classifications",
          "themes",
          "metrics_history",
          "llm_usage",
          "sync_streams",
          "pipeline_events",
        ]) {
          await tx`delete from ${tx(table)} where monitor_id = ${monitorId}`;
        }
      });
    } catch (err) {
      console.error("[monitors] purge failed", err);
    } finally {
      await sqlDb.end({ timeout: 3 });
    }
  }
  await supabase.from("monitors").delete().eq("id", monitorId);
  redirect("/");
}
