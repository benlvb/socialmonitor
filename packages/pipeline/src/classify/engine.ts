import type { Db } from "@socialmonitor/db";
import {
  DYNAMIC_EXAMPLES_PER_SIDE,
  classificationOutputSchema,
  buildClassificationJsonSchema,
  selectDedupCandidates,
  type ClassificationOutput,
  type Source,
} from "@socialmonitor/shared";
import {
  getMonthCostUsd,
  getRecentVerdicts,
  getStreamState,
  getThemeCandidates,
  getTodayCalls,
  getUnclassifiedItems,
  hasEventToday,
  insertClassification,
  markStreamSuccess,
  mergeTheme,
  recordUsage,
  updateStreamMeta,
  type MonitorRow,
  type UnclassifiedItem,
} from "../db/repos";
import { logEvent } from "../events";
import {
  DEFAULT_CLASSIFY_MODEL,
  collectBatchResults,
  createAnthropic,
  estimateCostUsd,
  getBatchStatus,
  submitClassifyBatch,
  type ClassifyRequest,
} from "./anthropic";
import { buildClassifyPrompt, PROMPT_VERSION } from "./prompt";
import { prefilterReason } from "./prefilter";
import { GLOBAL_CAP_USD } from "./anthropic";

const CLASSIFY_STREAM = "classify";
const BATCH_LIMIT = 50;

/**
 * Classify job for one (monitor, source) — SPEC section 6, D13, D14.
 * Batch lifecycle spans runs: tick N submits a batch and stores its id in
 * stream meta; tick N+1 collects it, writes results, and submits the next.
 * The hard budget cap pauses THIS path only — fetch never stops.
 */
export async function runClassify(sql: Db, monitor: MonitorRow, source: Source): Promise<void> {
  const state = await getStreamState(sql, monitor.id, source, CLASSIFY_STREAM);
  const meta = (state?.cursor_meta ?? {}) as { batch_id?: string; item_count?: number };

  const client = createAnthropic();
  const fixtureMode = process.env.FIXTURE_MODE === "1";

  // Phase A: collect a pending batch if one exists.
  if (meta.batch_id && client) {
    const status = await getBatchStatus(client, meta.batch_id);
    if (status !== "ended") {
      console.log(`[classify] ${monitor.name}/${source}: batch ${meta.batch_id} still processing`);
      return;
    }
    await collectAndWrite(sql, monitor, source, client, meta.batch_id);
    await updateStreamMeta(sql, monitor.id, source, CLASSIFY_STREAM, {});
  }

  // Phase B: budget gates.
  const monthCost = await getMonthCostUsd(sql);
  if (monthCost >= GLOBAL_CAP_USD) {
    if (!(await hasEventToday(sql, null, "budget_paused"))) {
      await logEvent(sql, {
        level: "error",
        kind: "budget_paused",
        message: `Global monthly LLM cap hit ($${monthCost.toFixed(2)} >= $${GLOBAL_CAP_USD}). Classification paused; fetching continues.`,
      });
    }
    return;
  }
  const todayCalls = await getTodayCalls(sql, monitor.id);
  const dailyBudget = monitor.config.budgets.daily_classifications;
  const remaining = Math.max(0, dailyBudget - todayCalls);
  if (remaining === 0) {
    console.log(`[classify] ${monitor.name}: daily budget spent (${todayCalls}/${dailyBudget})`);
    return;
  }

  // Phase C: gather work.
  const items = await getUnclassifiedItems(sql, monitor.id, source, Math.min(BATCH_LIMIT, remaining));
  if (items.length === 0) return;

  // Pre-filter: free heuristic noise, written directly (no tokens spent).
  const toClassify: UnclassifiedItem[] = [];
  for (const item of items) {
    const reason = prefilterReason(item.content, monitor.config);
    if (reason) {
      await insertClassification(sql, {
        monitorId: monitor.id,
        source,
        externalId: item.external_id,
        relevant: false,
        signalType: "noise",
        sentiment: "neutral",
        tags: [],
        score: null,
        description: "",
        matchedExisting: false,
        reasoning: `prefilter: ${reason}`,
        model: "prefilter",
        promptVersion: PROMPT_VERSION,
      });
    } else {
      toClassify.push(item);
    }
  }
  if (toClassify.length === 0) {
    await markStreamSuccess(sql, monitor.id, source, CLASSIFY_STREAM, null, items.length);
    return;
  }

  // Phase D: build prompts.
  const [verdicts, themes] = await Promise.all([
    getRecentVerdicts(sql, monitor.id, DYNAMIC_EXAMPLES_PER_SIDE * 4),
    getThemeCandidates(sql, monitor.id, source),
  ]);
  const requests: ClassifyRequest[] = toClassify.map((item) => ({
    id: item.external_id,
    prompt: buildClassifyPrompt(
      monitor.config,
      source,
      verdicts,
      selectDedupCandidates(item.content, themes),
      item,
    ),
  }));
  const schema = buildClassificationJsonSchema(monitor.config);

  if (!client) {
    if (fixtureMode) {
      // Stub classifier: plumbing verification without an API key (D22).
      await writeStubResults(sql, monitor, source, toClassify);
      await markStreamSuccess(sql, monitor.id, source, CLASSIFY_STREAM, null, items.length);
      return;
    }
    console.log(`[classify] ${monitor.name}/${source}: anthropic unconfigured, skipping`);
    return;
  }

  // Phase E: submit batch (collected next tick).
  const model = monitor.config.model.classify || DEFAULT_CLASSIFY_MODEL;
  const batchId = await submitClassifyBatch(client, model, schema, requests);
  await updateStreamMeta(sql, monitor.id, source, CLASSIFY_STREAM, {
    batch_id: batchId,
    item_count: requests.length,
    model,
    submitted_at: new Date().toISOString(),
  });
  console.log(
    `[classify] ${monitor.name}/${source}: submitted batch ${batchId} (${requests.length} items)`,
  );
}

async function collectAndWrite(
  sql: Db,
  monitor: MonitorRow,
  source: Source,
  client: NonNullable<ReturnType<typeof createAnthropic>>,
  batchId: string,
): Promise<void> {
  const state = await getStreamState(sql, monitor.id, source, CLASSIFY_STREAM);
  const meta = (state?.cursor_meta ?? {}) as { model?: string };
  const model = meta.model || monitor.config.model.classify || DEFAULT_CLASSIFY_MODEL;
  const results = await collectBatchResults(client, batchId);

  let processed = 0;
  let succeeded = 0;
  let calls = 0;
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  const validator = classificationOutputSchema(monitor.config);

  for (const [externalId, r] of results) {
    processed++;
    if (r.usage) {
      calls++;
      inTok += r.usage.input_tokens;
      outTok += r.usage.output_tokens;
      cost += estimateCostUsd(model, r.usage, true);
    }
    if (r.error || r.json == null) continue;
    const parsed = validator.safeParse(r.json);
    if (!parsed.success) continue;
    await writeClassification(sql, monitor, source, externalId, parsed.data, model);
    succeeded++;
  }

  if (calls > 0) await recordUsage(sql, monitor.id, calls, inTok, outTok, cost);

  // Mass-failure guard (SPEC section 9): a run that classified zero items is
  // broken, not successful.
  if (processed > 0 && succeeded === 0) {
    await logEvent(sql, {
      monitorId: monitor.id,
      source,
      stream: CLASSIFY_STREAM,
      level: "error",
      kind: "mass_failure",
      message: `Batch ${batchId}: ${processed} items processed, 0 classified successfully`,
    });
    return;
  }

  await markStreamSuccess(sql, monitor.id, source, CLASSIFY_STREAM, null, succeeded);
  console.log(`[classify] ${monitor.name}/${source}: batch ${batchId} → ${succeeded}/${processed} classified ($${cost.toFixed(4)})`);
}

async function writeClassification(
  sql: Db,
  monitor: MonitorRow,
  source: Source,
  externalId: string,
  output: ClassificationOutput,
  model: string,
): Promise<void> {
  const tags = output.tags.length > 0 ? output.tags : output.relevant ? ["General"] : [];
  const matched = output.matched_existing_description.trim();
  const description = output.relevant ? matched || output.description : "";

  await insertClassification(sql, {
    monitorId: monitor.id,
    source,
    externalId,
    relevant: output.relevant,
    signalType: output.signal_type,
    sentiment: output.sentiment,
    tags,
    score: output.score,
    description,
    matchedExisting: matched.length > 0,
    reasoning: output.reasoning,
    model,
    promptVersion: PROMPT_VERSION,
  });

  if (!output.relevant || output.signal_type === "noise" || !description) return;

  const itemRows = await sql`
    select url, author_handle, author_name, posted_at
    from raw_items
    where monitor_id = ${monitor.id} and source = ${source} and external_id = ${externalId}
    limit 1`;
  const item = itemRows[0];
  await mergeTheme(sql, {
    monitorId: monitor.id,
    source,
    signalType: output.signal_type,
    description,
    tags,
    score: output.score,
    author: (item?.author_handle as string) || (item?.author_name as string) || "",
    itemRef: {
      externalId,
      url: (item?.url as string) ?? "",
      author: (item?.author_handle as string) ?? "",
      postedAt: item?.posted_at ? new Date(item.posted_at as Date).toISOString() : "",
    },
  });
}

/** Deterministic stub for fixture-mode plumbing tests — never used with a real key. */
async function writeStubResults(
  sql: Db,
  monitor: MonitorRow,
  source: Source,
  items: UnclassifiedItem[],
): Promise<void> {
  for (const item of items) {
    const text = item.content.toLowerCase();
    const signalType = text.includes("?")
      ? "question"
      : /broken|bug|down|fail|crash|slow/.test(text)
        ? "complaint"
        : /wish|please add|would love|feature/.test(text)
          ? "feature_request"
          : /love|great|awesome|amazing/.test(text)
            ? "praise"
            : "opinion";
    const output: ClassificationOutput = {
      reasoning: "stub classifier (fixture mode, no API key)",
      relevant: true,
      signal_type: monitor.config.signal_types.includes(signalType) ? signalType : monitor.config.signal_types[0]!,
      sentiment: signalType === "complaint" ? "negative" : signalType === "praise" ? "positive" : "neutral",
      tags: [],
      score: 5,
      description: item.content.slice(0, 120),
      matched_existing_description: "",
    };
    await writeClassification(sql, monitor, source, item.external_id, output, "stub");
  }
}
