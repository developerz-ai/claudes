import { describe, expect, test } from "bun:test";
import { assertNoKeyFragment } from "../../test-support/redact";
import { KEY, sampleConfig, TIERS } from "../harness";
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

  for (const role of ["model", "advisorModel", "subagentModel"] as const) {
    for (const prefix of ["", "custom-"]) {
      for (const served of [true, false]) {
        test(`redacts ${prefix ? "embedded" : "bare"} key-shaped ${role} IDs when ${served ? "served" : "missing"}`, () => {
          const id = `${prefix}${KEY}`;
          const config = sampleConfig({
            tiers: {
              ...TIERS,
              ...(role === "model" ? { sonnet: id } : {}),
              ...(role === "advisorModel" ? { haiku: id } : {}),
            },
            subagentModel: role === "subagentModel" ? id : TIERS.opus,
          });
          const snapshot = structuredClone(config);
          const entries = [
            { role: "model", id: config.tiers.sonnet },
            { role: "advisorModel", id: config.tiers.haiku },
            { role: "subagentModel", id: config.subagentModel },
          ];
          const results = checkEffectiveModel({
            config,
            // Missing cases also leave ordinary IDs unserved to exercise mixed WARN titles.
            modelIds: served ? entries.map((entry) => entry.id ?? "") : [`${prefix}mar_live_…`],
          });
          const title = results[0]?.title ?? "";
          assertNoKeyFragment(title, KEY);
          expect(results).toHaveLength(1);
          expect(results[0]?.status).toBe(served ? "PASS" : "WARN");
          const displayed = entries
            .map(
              (entry) => `${entry.role}=${entry.role === role ? `${prefix}mar_live_…` : entry.id}`,
            )
            .join(", ");
          expect(title).toBe(
            `${served ? "effective models:" : "the router does not serve"} ${displayed}`,
          );
          if (!served) {
            expect(results[0]?.fix).toBe(
              "re-run `claudes login` (or pass a --sonnet/--haiku override) so every effective model is served",
            );
          }
          expect(config).toEqual(snapshot);
        });
      }
    }
  }

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
