import { describe, expect, it } from "vitest";
import {
  buildClassificationJsonSchema,
  classificationOutputSchema,
} from "../src/classification";
import { parseMonitorConfig } from "../src/monitor-config";

const config = parseMonitorConfig({
  tags: [{ name: "Mobile UX" }, { name: "Pricing" }, { name: "General" }],
});

describe("buildClassificationJsonSchema", () => {
  it("builds enums from monitor config at runtime", () => {
    const s = buildClassificationJsonSchema(config) as any;
    expect(s.properties.signal_type.enum).toContain("feature_request");
    expect(s.properties.tags.items.enum).toEqual(["Mobile UX", "Pricing", "General"]);
    expect(s.properties.tags.maxItems).toBe(3);
    expect(s.required).toContain("reasoning");
  });
});

describe("classificationOutputSchema", () => {
  const base = {
    reasoning: "user reports broken login",
    relevant: true,
    signal_type: "complaint",
    sentiment: "negative",
    score: 7,
    description: "login broken on mobile",
    matched_existing_description: "",
  };
  it("drops off-list tags instead of erroring", () => {
    const out = classificationOutputSchema(config).parse({
      ...base,
      tags: ["Mobile UX", "Hallucinated Tag"],
    });
    expect(out.tags).toEqual(["Mobile UX"]);
  });
  it("rejects off-list signal_type", () => {
    expect(() =>
      classificationOutputSchema(config).parse({ ...base, tags: [], signal_type: "not_a_type" }),
    ).toThrow();
  });
  it("truncates over-long descriptions", () => {
    const out = classificationOutputSchema(config).parse({
      ...base,
      tags: [],
      description: "x".repeat(300),
    });
    expect(out.description.length).toBe(200);
  });
});
