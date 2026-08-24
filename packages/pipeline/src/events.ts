import type { Db } from "@socialmonitor/db";
import { notify } from "./notify";

export type EventLevel = "info" | "warn" | "error";

export interface PipelineEvent {
  monitorId?: string | null;
  source?: string | null;
  stream?: string | null;
  level: EventLevel;
  kind: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** Kinds that page the operator via the notifier (SPEC section 8). */
const ALERT_KINDS = new Set([
  "breaker_tripped",
  "summary_failed",
  "budget_paused",
  "mass_failure",
  "canary_message_content",
  "drift_detected",
  "summary_truncated",
]);

export async function logEvent(sql: Db | null, e: PipelineEvent): Promise<void> {
  const line = `[${e.level}] ${e.kind}: ${e.message}`;
  if (e.level === "error") console.error(line);
  else console.log(line);

  if (sql) {
    try {
      await sql`
        insert into pipeline_events (monitor_id, source, stream, level, kind, message, meta)
        values (${e.monitorId ?? null}, ${e.source ?? null}, ${e.stream ?? null},
                ${e.level}, ${e.kind}, ${e.message}, ${sql.json((e.meta ?? {}) as never)})`;
    } catch (err) {
      console.error("[events] failed to persist event", err);
    }
  }

  if (e.level === "error" || ALERT_KINDS.has(e.kind)) {
    await notify(`${e.kind}\n${e.message}${e.source ? `\nsource: ${e.source}` : ""}${e.stream ? ` stream: ${e.stream}` : ""}`);
  }
}
