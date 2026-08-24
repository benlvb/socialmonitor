import Anthropic from "@anthropic-ai/sdk";
import { PROMPT_CACHE_MARKER } from "@socialmonitor/shared";
import type { BuiltPrompt } from "./prompt";

/**
 * Anthropic transport for the classifier (D12).
 * Classification runs through the Message Batches API (50% price, latency
 * tolerated by the 30-min cadence). The pending batch id is persisted in
 * sync_streams.cursor_meta by the engine — submit on one tick, collect on the next.
 * Model IDs are exact, undated strings per the API reference: claude-haiku-4-5 default.
 */

export const DEFAULT_CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || "claude-haiku-4-5";
export const DEFAULT_NARRATE_MODEL = process.env.NARRATE_MODEL || "claude-sonnet-5";

/** $ per 1M tokens (input, output) at standard price; batch is half. */
/** Hard monthly ceiling (D13): pauses all discretionary LLM spend, never fetching. */
export const GLOBAL_CAP_USD = Number(process.env.GLOBAL_MONTHLY_LLM_CAP_USD ?? 50);

const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function estimateCostUsd(model: string, usage: UsageLike, batch: boolean): number {
  // Unknown model: assume the MOST expensive tier — pricing at 0 silently
  // disabled the $50 hard cap for any off-table model string (audit #6).
  const p = MODEL_PRICES[model] ?? MODEL_PRICES["claude-fable-5"]!;
  const mult = batch ? 0.5 : 1;
  const perTok = 1 / 1_000_000;
  const cost =
    usage.input_tokens * p.in * perTok +
    usage.output_tokens * p.out * perTok +
    (usage.cache_read_input_tokens ?? 0) * p.in * 0.1 * perTok +
    (usage.cache_creation_input_tokens ?? 0) * p.in * 1.25 * perTok;
  return cost * mult;
}

import type { Db } from "@socialmonitor/db";
import { resolveCredentials } from "../adapters/credentials";

let cachedClient: { key: string; client: Anthropic } | null = null;

/**
 * Vault-aware client (audit #7): the Connections page must actually activate
 * Anthropic (D22), not silently require env vars. Env still works as the
 * bootstrap fallback via resolveCredentials.
 */
export async function createAnthropic(sql: Db | null, ownerId: string): Promise<Anthropic | null> {
  const creds = await resolveCredentials(sql, ownerId, "anthropic");
  const key = creds?.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (cachedClient?.key !== key) {
    cachedClient = { key, client: new Anthropic({ apiKey: key }) };
  }
  return cachedClient.client;
}

export interface ClassifyRequest {
  id: string; // custom_id = externalId
  prompt: BuiltPrompt;
}

function requestParams(
  model: string,
  prompt: BuiltPrompt,
  schema: Record<string, unknown>,
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: prompt.staticPrefix,
        // Static per-monitor prefix; below the model's minimum cacheable size
        // this silently no-ops, which is acceptable (SPEC section 6).
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: prompt.volatile }],
  };
  // Structured output: output_config.format (the current API shape). The SDK's
  // typed params may lag the runtime-built schema use case, so set it defensively.
  (params as unknown as Record<string, unknown>).output_config = {
    format: { type: "json_schema", schema },
  };
  return params;
}

export async function submitClassifyBatch(
  client: Anthropic,
  model: string,
  schema: Record<string, unknown>,
  requests: ClassifyRequest[],
): Promise<string> {
  const batch = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.id,
      params: requestParams(model, r.prompt, schema),
    })),
  });
  return batch.id;
}

export type BatchStatus = "processing" | "ended";

export async function getBatchStatus(client: Anthropic, batchId: string): Promise<BatchStatus> {
  const batch = await client.messages.batches.retrieve(batchId);
  return batch.processing_status === "ended" ? "ended" : "processing";
}

export interface BatchItemResult {
  json: unknown | null;
  usage: UsageLike | null;
  error: string | null;
}

/** Collect results keyed by custom_id — order is never positional. */
export async function collectBatchResults(
  client: Anthropic,
  batchId: string,
): Promise<Map<string, BatchItemResult>> {
  const out = new Map<string, BatchItemResult>();
  for await (const result of await client.messages.batches.results(batchId)) {
    const id = result.custom_id;
    if (result.result.type === "succeeded") {
      const message = result.result.message;
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      let json: unknown | null = null;
      let error: string | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        error = "response was not valid JSON";
      }
      out.set(id, { json, usage: message.usage as UsageLike, error });
    } else {
      out.set(id, { json: null, usage: null, error: result.result.type });
    }
  }
  return out;
}

/** Realtime single call — used by /ask later and by small immediate runs. */
export async function classifyRealtime(
  client: Anthropic,
  model: string,
  schema: Record<string, unknown>,
  prompt: BuiltPrompt,
): Promise<BatchItemResult> {
  try {
    const response = await client.messages.create(requestParams(model, prompt, schema));
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { json: JSON.parse(text), usage: response.usage as UsageLike, error: null };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return { json: null, usage: null, error: `rate_limited: ${err.message}` };
    }
    if (err instanceof Anthropic.APIError) {
      return { json: null, usage: null, error: `api_error ${err.status}: ${err.message}` };
    }
    return { json: null, usage: null, error: String(err) };
  }
}
