import { describe, expect, it } from "vitest";
import { parseMonitorConfig, validateMonitorConfig } from "../src/monitor-config";
import { DEFAULT_SIGNAL_TYPES } from "../src/constants";

describe("parseMonitorConfig", () => {
  it("fully defaults an empty config", () => {
    const c = parseMonitorConfig({});
    expect(c.signal_types).toEqual([...DEFAULT_SIGNAL_TYPES]);
    expect(c.budgets.daily_classifications).toBe(500);
    expect(c.cadence_minutes).toEqual({ fetch: 30, classify: 30, metrics: 15 });
    expect(c.toggles.youtube_comments).toBe(true);
    expect(c.toggles.ask_tool_approval).toBe(false);
    expect(c.limits.metrics_checkpoints).toEqual(["1h", "24h", "7d"]);
  });
  it("accepts null/undefined as empty", () => {
    expect(parseMonitorConfig(null).budgets.x_reads_per_day).toBe(2000);
  });
  it("signal_types is editable config, not a fixed enum", () => {
    const c = parseMonitorConfig({ signal_types: ["scam_report", "noise"] });
    expect(c.signal_types).toEqual(["scam_report", "noise"]);
  });
});

describe("validateMonitorConfig", () => {
  it("returns readable issues for the JSON editor", () => {
    const r = validateMonitorConfig({ budgets: { daily_classifications: -5 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("budgets.daily_classifications");
  });
});

describe("prefilter config", () => {
  it("defaults min_chars and mute_patterns", () => {
    const c = parseMonitorConfig({});
    expect(c.prefilter.min_chars).toBe(8);
    expect(c.prefilter.mute_patterns).toEqual([]);
  });
});

describe("appstore storefronts", () => {
  it("defaults to the US storefront", () => {
    expect(parseMonitorConfig({}).limits.appstore_storefronts).toEqual(["us"]);
  });
  it("accepts lowercase two-letter codes and rejects anything else", () => {
    expect(parseMonitorConfig({ limits: { appstore_storefronts: ["us", "gb", "my"] } }).limits.appstore_storefronts).toEqual(["us", "gb", "my"]);
    const r = validateMonitorConfig({ limits: { appstore_storefronts: ["USA"] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("appstore_storefronts");
    expect(validateMonitorConfig({ limits: { appstore_storefronts: [] } }).ok).toBe(false);
  });
});
