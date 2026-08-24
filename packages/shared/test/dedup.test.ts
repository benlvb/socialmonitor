import { describe, expect, it } from "vitest";
import { formatShortlist, jaccard, selectDedupCandidates, tokenize } from "../src/dedup";

describe("tokenize", () => {
  it("lowercases, keeps alnum tokens >= 3 chars", () => {
    expect(tokenize("Perps UI is SO laggy!! v2")).toEqual(new Set(["perps", "laggy"]));
  });
  it("empty input", () => {
    expect(tokenize("")).toEqual(new Set());
  });
});

describe("jaccard", () => {
  it("identical sets = 1", () => {
    expect(jaccard(new Set(["a1b", "c2d"]), new Set(["a1b", "c2d"]))).toBe(1);
  });
  it("disjoint = 0, empty = 0", () => {
    expect(jaccard(new Set(["abc"]), new Set(["def"]))).toBe(0);
    expect(jaccard(new Set(), new Set(["def"]))).toBe(0);
  });
  it("partial overlap", () => {
    expect(jaccard(new Set(["aaa", "bbb"]), new Set(["bbb", "ccc"]))).toBeCloseTo(1 / 3);
  });
});

describe("selectDedupCandidates", () => {
  const themes = Array.from({ length: 60 }, (_, i) => ({
    signal_type: "complaint",
    description: `unique theme number ${i} about topic${i}`,
    item_count: i,
    score_avg: 5,
  }));
  it("caps at topK and tops up with popular entries", () => {
    const picks = selectDedupCandidates("unique theme number 7 about topic7", themes, 40, 10);
    expect(picks.length).toBe(40);
    expect(picks[0]!.description).toContain("number 7");
    expect(picks.some((p) => p.item_count === 59)).toBe(true);
  });
  it("empty existing", () => {
    expect(selectDedupCandidates("anything", [])).toEqual([]);
  });
});

describe("formatShortlist", () => {
  it("never renders tags", () => {
    const out = formatShortlist([
      { signal_type: "complaint", description: "login broken on mobile", item_count: 4, score_avg: 6.5 },
    ]);
    expect(out).toContain("[complaint] login broken on mobile (count: 4, avg_score: 6.5)");
    expect(out).not.toMatch(/tags|categor/i);
  });
  it("empty list placeholder", () => {
    expect(formatShortlist([])).toContain("first entry");
  });
});
