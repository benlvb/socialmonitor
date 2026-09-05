import { z } from "zod";
import { DEFAULT_SIGNAL_TYPES, METRIC_CHECKPOINTS } from "./constants";

export const SeedExampleSchema = z.object({
  text: z.string().min(1),
  relevant: z.boolean(),
  signal_type: z.string().optional(),
  tags: z.array(z.string()).max(3).optional(),
  why: z.string().min(1),
});
export type SeedExample = z.infer<typeof SeedExampleSchema>;

export const TagDefSchema = z.object({
  name: z.string().min(1),
  hint: z.string().optional(), // one-line disambiguation, rendered in the prompt
});

/**
 * Per-monitor configuration (SPEC section 4). Stored in monitors.config as jsonb.
 * Every limit/budget is runtime-editable — no deploys to change behavior.
 */
export const MonitorConfigSchema = z.object({
  context: z.string().default(""),
  signal_types: z.array(z.string().min(1)).min(2).default([...DEFAULT_SIGNAL_TYPES]),
  tags: z
    .array(TagDefSchema)
    .default([{ name: "General", hint: "LAST RESORT ONLY - never alongside another tag." }]),
  noise_rules: z.string().default(""),
  seed_examples: z.array(SeedExampleSchema).default([]),
  budgets: z
    .object({
      daily_classifications: z.number().int().min(0).default(500),
      youtube_searches_per_day: z.number().int().min(0).default(20),
      x_reads_per_day: z.number().int().min(0).default(2000),
    })
    .prefault({}),
  cadence_minutes: z
    .object({
      fetch: z.number().int().min(5).default(30),
      classify: z.number().int().min(5).default(30),
      metrics: z.number().int().min(5).default(15),
    })
    .prefault({}),
  toggles: z
    .object({
      youtube_videos: z.boolean().default(true),
      youtube_comments: z.boolean().default(true),
      reddit_comments: z.boolean().default(true),
      transcripts: z.boolean().default(false),
      ask_tool_approval: z.boolean().default(false),
    })
    .prefault({}),
  limits: z
    .object({
      youtube_comment_max_video_age_days: z.number().int().min(1).default(7),
      reddit_comment_max_post_age_days: z.number().int().min(1).default(3),
      reddit_comment_depth: z.number().int().min(1).max(3).default(1),
      metrics_checkpoints: z.array(z.enum(METRIC_CHECKPOINTS)).default(["1h", "24h", "7d"]),
      max_pages_per_fetch: z.number().int().min(1).max(10).default(3),
      /** App Store storefronts (ISO country codes) each `app` target is read from (D23). */
      appstore_storefronts: z
        .array(z.string().regex(/^[a-z]{2}$/, "two-letter lowercase storefront code, e.g. us"))
        .min(1)
        .max(20)
        .default(["us"]),
    })
    .prefault({}),
  prefilter: z
    .object({
      min_chars: z.number().int().min(0).default(8),
      mute_patterns: z.array(z.string()).default([]),
    })
    .prefault({}),
  model: z
    .object({
      classify: z.string().optional(),
      narrate: z.string().optional(),
    })
    .prefault({}),
});
export type MonitorConfig = z.infer<typeof MonitorConfigSchema>;

/** Parse raw jsonb into a fully-defaulted config. Throws ZodError on invalid input. */
export function parseMonitorConfig(raw: unknown): MonitorConfig {
  return MonitorConfigSchema.parse(raw ?? {});
}

/** Validation for the web JSON editor: returns issues instead of throwing. */
export function validateMonitorConfig(raw: unknown):
  | { ok: true; config: MonitorConfig }
  | { ok: false; issues: string[] } {
  const r = MonitorConfigSchema.safeParse(raw ?? {});
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
