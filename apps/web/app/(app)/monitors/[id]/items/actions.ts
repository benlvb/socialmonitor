"use server";

import { revalidatePath } from "next/cache";
import { createDb } from "@socialmonitor/db";
import { requireUser } from "../../../../../lib/supabase/server";

export interface CorrectionState {
  error?: string;
  message?: string;
}

/**
 * Inline correction (D18): writes a review_verdict (feeds dynamic few-shot),
 * rewrites the classification row, and adjusts themes so the dashboard
 * reflects the fix. Service path is ownership-verified via RLS first.
 */
export async function correctClassification(
  _prev: CorrectionState,
  formData: FormData,
): Promise<CorrectionState> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "Not signed in." };

  const monitorId = String(formData.get("monitor_id"));
  const source = String(formData.get("source"));
  const externalId = String(formData.get("external_id"));

  // Ownership check under RLS: if the monitor isn't visible, stop.
  const { data: monitor } = await supabase
    .from("monitors")
    .select("id")
    .eq("id", monitorId)
    .single();
  if (!monitor) return { error: "Monitor not found." };

  const sql = createDb();
  if (!sql) return { error: "DATABASE_URL not configured on the web app." };

  try {
    const oldRows = await sql`
      select relevant, signal_type, sentiment, tags, score, description
      from item_classifications
      where monitor_id = ${monitorId} and source = ${source} and external_id = ${externalId}`;
    const old = oldRows[0];
    if (!old) return { error: "Classification not found." };

    const itemRows = await sql`
      select content, url, author_handle, author_name, posted_at from raw_items
      where monitor_id = ${monitorId} and source = ${source} and external_id = ${externalId}
      limit 1`;
    const item = itemRows[0];

    const corrected = {
      relevant: formData.get("relevant") === "true",
      signal_type: String(formData.get("signal_type")),
      sentiment: String(formData.get("sentiment")),
      tags: String(formData.get("tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3),
      score: formData.get("score") ? Number(formData.get("score")) : null,
      description: String(formData.get("description") ?? "").slice(0, 200),
    };
    const note = String(formData.get("note") ?? "");

    await sql`
      insert into review_verdicts (monitor_id, source, external_id, item_text, original, corrected, note)
      values (${monitorId}, ${source}, ${externalId}, ${(item?.content as string) ?? ""},
              ${sql.json(old as never)}, ${sql.json(corrected as never)}, ${note})`;

    await sql`
      update item_classifications set
        relevant = ${corrected.relevant},
        signal_type = ${corrected.signal_type},
        sentiment = ${corrected.sentiment},
        tags = ${corrected.tags},
        score = ${corrected.score},
        description = ${corrected.description},
        corrected = true,
        classified_at = now()
      where monitor_id = ${monitorId} and source = ${source} and external_id = ${externalId}`;

    // Theme adjustment: remove from the old theme, merge into the new one.
    const oldDesc = old.description as string;
    if (old.relevant && oldDesc) {
      await sql`
        update themes set item_count = greatest(item_count - 1, 0), updated_at = now()
        where monitor_id = ${monitorId} and source = ${source}
          and signal_type = ${old.signal_type} and description = ${oldDesc}`;
      await sql`
        delete from themes
        where monitor_id = ${monitorId} and source = ${source}
          and signal_type = ${old.signal_type} and description = ${oldDesc}
          and item_count = 0`;
    }
    if (corrected.relevant && corrected.signal_type !== "noise" && corrected.description) {
      const { mergeTheme } = await import("@socialmonitor/pipeline/repos");
      await mergeTheme(sql, {
        monitorId,
        source: source as never,
        signalType: corrected.signal_type,
        description: corrected.description,
        tags: corrected.tags,
        score: corrected.score,
        author: (item?.author_handle as string) ?? "",
        itemRef: {
          externalId,
          url: (item?.url as string) ?? "",
          author: (item?.author_handle as string) ?? "",
          postedAt: item?.posted_at ? new Date(item.posted_at as Date).toISOString() : "",
        },
      });
    }
  } catch (err) {
    return { error: `Correction failed: ${String(err)}` };
  } finally {
    await sql.end({ timeout: 3 });
  }

  revalidatePath(`/monitors/${monitorId}/items`);
  return { message: "Corrected — this verdict now teaches the classifier as a few-shot example." };
}
