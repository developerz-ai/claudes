import { describe, expect, test } from "bun:test";
import { sampleConfig, TIERS } from "../harness";
import { checkEffectiveModel } from "./effective-model";

const ALL_SERVED = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];

describe("checkEffectiveModel", () => {
  test("resolves model=sonnet and advisorModel=haiku and passes when both are served", () => {
    const results = checkEffectiveModel({ config: sampleConfig(), modelIds: ALL_SERVED });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("PASS");
    expect(results[0]?.title).toContain(`model=${TIERS.sonnet}`);
    expect(results[0]?.title).toContain(`advisorModel=${TIERS.haiku}`);
  });

  test("includes the subagent model when configured", () => {
    const results = checkEffectiveModel({
      config: sampleConfig({ subagentModel: "claude-haiku-4-5" }),
      modelIds: ALL_SERVED,
    });
    expect(results[0]?.title).toContain("subagentModel=claude-haiku-4-5");
  });

  test("WARNs when an effective model is not served, naming it and the remedy", () => {
    const results = checkEffectiveModel({
      config: sampleConfig(),
      modelIds: ["claude-opus-5-5"],
    });
    expect(results[0]?.status).toBe("WARN");
    expect(results[0]?.title).toContain(`model=${TIERS.sonnet}`);
    expect(results[0]?.title).toContain(`advisorModel=${TIERS.haiku}`);
    expect(results[0]?.fix).toContain("re-run `claudes login`");
  });

  test("WARNs for an unserved subagent model only", () => {
    const results = checkEffectiveModel({
      config: sampleConfig({ subagentModel: "claude-opus-3-0" }),
      modelIds: ALL_SERVED,
    });
    expect(results[0]?.status).toBe("WARN");
    expect(results[0]?.title).toContain("subagentModel=claude-opus-3-0");
    expect(results[0]?.title).not.toContain(TIERS.sonnet);
  });
});
