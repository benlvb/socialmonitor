import { z } from "zod";
import { MAX_DESCRIPTION_CHARS, MAX_TAGS_PER_ITEM, SENTIMENTS } from "./constants.js";
import type { MonitorConfig } from "./monitor-config.js";

/** Runtime validator for one classifier response (post-parse belt-and-braces). */
export function classificationOutputSchema(config: MonitorConfig) {
  const signalTypes = config.signal_types as [string, ...string[]];
  const tagNames = config.tags.map((t) => t.name);
  return z
    .object({
      reasoning: z.string(),
      relevant: z.boolean(),
      signal_type: z.enum(signalTypes),
      sentiment: z.enum(SENTIMENTS),
      tags: z.array(z.string()).max(MAX_TAGS_PER_ITEM),
      score: z.number().int().min(1).max(10),
      description: z.string().max(MAX_DESCRIPTION_CHARS * 2), // hard-truncated below
      matched_existing_description: z.string(),
    })
    .transform((o) => ({
      ...o,
      // Off-list tags are dropped, not errors (SPEC section 6)
      tags: o.tags.filter((t) => tagNames.includes(t)).slice(0, MAX_TAGS_PER_ITEM),
      description: o.description.slice(0, MAX_DESCRIPTION_CHARS),
    }));
}
export type ClassificationOutput = z.infer<ReturnType<typeof classificationOutputSchema>>;

/**
 * JSON Schema sent to the LLM for native structured output.
 * Enums are built at runtime from monitor config (D3): editing the taxonomy
 * changes the schema on the next call — no migration, no deploy.
 */
export function buildClassificationJsonSchema(config: MonitorConfig): Record<string, unknown> {
  const tagNames = config.tags.map((t) => t.name);
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "reasoning",
      "relevant",
      "signal_type",
      "sentiment",
      "tags",
      "score",
      "description",
      "matched_existing_description",
    ],
    properties: {
      reasoning: {
        type: "string",
        description:
          "1-2 sentences citing the specific phrasing that drove the call. Fill this FIRST.",
      },
      relevant: { type: "boolean" },
      signal_type: { type: "string", enum: config.signal_types },
      sentiment: { type: "string", enum: [...SENTIMENTS] },
      tags: {
        type: "array",
        items: tagNames.length > 0 ? { type: "string", enum: tagNames } : { type: "string" },
        maxItems: MAX_TAGS_PER_ITEM,
      },
      score: { type: "integer", minimum: 1, maximum: 10 },
      description: { type: "string", maxLength: MAX_DESCRIPTION_CHARS },
      matched_existing_description: { type: "string" },
    },
  };
}
