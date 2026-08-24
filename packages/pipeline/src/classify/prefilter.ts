import type { MonitorConfig } from "@socialmonitor/shared";

const URL_ONLY = /^(?:\s*https?:\/\/\S+\s*)+$/i;

/**
 * Free heuristic gate before any LLM call (D13). Returns a reason string when
 * the item is auto-classified as noise without spending tokens; null otherwise.
 * Deliberately conservative: when unsure, let the LLM decide.
 */
export function prefilterReason(content: string, config: MonitorConfig): string | null {
  const text = (content ?? "").trim();
  if (text.length === 0) return "empty content";
  if (text.length < config.prefilter.min_chars) return "too short to carry signal";
  if (URL_ONLY.test(text)) return "link-only, no commentary";
  for (const pattern of config.prefilter.mute_patterns) {
    if (pattern && text.toLowerCase().includes(pattern.toLowerCase())) {
      return `matched mute pattern: ${pattern}`;
    }
  }
  return null;
}
