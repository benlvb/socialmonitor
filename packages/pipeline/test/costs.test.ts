import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/classify/anthropic";

const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("estimateCostUsd", () => {
  it("prices known models correctly", () => {
    expect(estimateCostUsd("claude-haiku-4-5", usage, false)).toBeCloseTo(6);
    expect(estimateCostUsd("claude-haiku-4-5", usage, true)).toBeCloseTo(3);
  });
  it("unknown models price at the MOST expensive tier, never 0 (audit #6)", () => {
    const unknown = estimateCostUsd("claude-opus-4-8", usage, false);
    expect(unknown).toBeCloseTo(60); // fable pricing: never lets the cap go infinite
    expect(estimateCostUsd("made-up-model", usage, false)).toBeGreaterThan(0);
  });
});
