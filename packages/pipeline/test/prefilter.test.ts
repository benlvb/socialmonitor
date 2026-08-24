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

describe("prefilter min_chars is config, not a constant", () => {
  it("a raised min_chars drops longer messages", () => {
    const strict = parseMonitorConfig({ prefilter: { min_chars: 30 } });
    expect(prefilterReason("short but real complaint", strict)).toContain("short");
  });
  it("a lowered min_chars keeps terse messages", () => {
    const loose = parseMonitorConfig({ prefilter: { min_chars: 3 } });
    expect(prefilterReason("app bad", loose)).toBeNull();
  });
});
