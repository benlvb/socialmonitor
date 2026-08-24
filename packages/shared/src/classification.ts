import { z } from "zod";
import { MAX_DESCRIPTION_CHARS, MAX_TAGS_PER_ITEM, SENTIMENTS } from "./constants";
import type { MonitorConfig } from "./monitor-config";

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
 *
 * IMPORTANT: only the keyword subset structured outputs accepts may appear here
 * (type / enum / properties / required / additionalProperties / items). Numeric,
 * string, and array-size constraints (minimum, maximum, maxLength, maxItems) are
 * NOT part of that subset — this schema is attached as a raw dict, so nothing
 * strips them and an unsupported keyword can reject every request. They are
 * expressed as `description` guidance instead, and enforced locally by
 * `classificationOutputSchema` (which caps tags and truncates the description).
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
        description: `The tags that capture what this is ABOUT. ONE tag is the normal answer; at most ${MAX_TAGS_PER_ITEM}. Do not pad.`,
      },
      score: {
        type: "integer",
        description:
          "Constructiveness from 1 to 10 inclusive. 1-3 venting/empty, 4-6 a real point buried in noise, 7-10 constructive and specific.",
      },
      description: {
        type: "string",
        description: `The dedup key: one sentence, under ${MAX_DESCRIPTION_CHARS} characters.`,
      },
      matched_existing_description: {
        type: "string",
        description:
          "Exact description of an existing tracked entry this matches, or an empty string.",
      },
    },
  };
}
