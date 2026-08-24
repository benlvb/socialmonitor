import { DEDUP_POPULAR_FLOOR, DEDUP_TOP_K } from "./constants.js";
import { flattenForPrompt } from "./defang.js";

export interface ThemeCandidate {
  signal_type: string;
  description: string;
  item_count: number;
  score_avg: number | null;
}

/** Lowercase alnum tokens of length >= 3. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of (text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Top-K by similarity to the new text, topped up with highest-count entries (SPEC section 6). */
export function selectDedupCandidates(
  newText: string,
  existing: ThemeCandidate[],
  topK = DEDUP_TOP_K,
  popularFloor = DEDUP_POPULAR_FLOOR,
): ThemeCandidate[] {
  const newTokens = tokenize(newText);
  const scored = existing
    .map((row) => ({ row, sim: jaccard(newTokens, tokenize(row.description)) }))
    .sort((a, b) => b.sim - a.sim || b.row.item_count - a.row.item_count);

  const simSlots = Math.max(0, topK - popularFloor);
  const simPicks = scored.slice(0, simSlots).map((s) => s.row);
  const picked = new Set(simPicks.map((r) => r.description));
  const popularPicks = [...existing]
    .sort((a, b) => b.item_count - a.item_count)
    .filter((r) => !picked.has(r.description))
    .slice(0, popularFloor);
  return [...simPicks, ...popularPicks];
}

/**
 * Render the dedup shortlist for the prompt.
 * DELIBERATELY omits tags/categories — the model copies them (measured 79%
 * contamination in the reference system). Never add them here.
 */
export function formatShortlist(candidates: ThemeCandidate[]): string {
  if (candidates.length === 0) return "(none yet — this will be the first entry)";
  return candidates
    .map(
      (row, i) =>
        `  ${i + 1}. [${row.signal_type}] ${flattenForPrompt(row.description, 200)} ` +
        `(count: ${row.item_count}, avg_score: ${row.score_avg ?? "-"})`,
    )
    .join("\n");
}
