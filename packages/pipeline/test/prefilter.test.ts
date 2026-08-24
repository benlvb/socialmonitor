import { describe, expect, it } from "vitest";
import { parseMonitorConfig } from "@socialmonitor/shared";
import { prefilterReason } from "../src/classify/prefilter";

const config = parseMonitorConfig({ prefilter: { mute_patterns: ["giveaway"] } });

describe("prefilterReason", () => {
  it("drops empty and too-short content", () => {
    expect(prefilterReason("", config)).toContain("empty");
    expect(prefilterReason("gm", config)).toContain("short");
  });
  it("drops link-only posts", () => {
    expect(prefilterReason("https://example.com/x https://a.b/c", config)).toContain("link-only");
  });
  it("drops configured mute patterns", () => {
    expect(prefilterReason("huge GIVEAWAY join now to win", config)).toContain("giveaway");
  });
  it("passes ordinary content to the LLM", () => {
    expect(prefilterReason("the app keeps crashing when I open settings", config)).toBeNull();
  });
});
