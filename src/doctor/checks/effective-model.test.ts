import { expect, test } from "bun:test";
import { resolveCatalog } from "../../launch/catalog";
import { sessionModel } from "../../launch/session-model";
import type { ModelEntry } from "../../router/client";
import { assertNoKeyFragment } from "../../test-support/redact";
import { KEY, sampleConfig, TIERS } from "../harness";
import { checkEffectiveModel } from "./effective-model";

const rows: readonly ModelEntry[] = [
  { id: TIERS.opus, contextTokens: 200000 },
  { id: TIERS.sonnet, contextTokens: 128000 },
  { id: TIERS.haiku },
];

test("doctor reports the actual default model and the router window", () => {
  const config = sampleConfig();
  const catalog = resolveCatalog(config, rows);
  const model = sessionModel(config, catalog, {}, undefined, undefined);
  expect(checkEffectiveModel(config, catalog, model)).toEqual([
    {
      status: "PASS",
      title: `effective models: model=${TIERS.opus}, context window 200000 tokens (router catalog)`,
    },
  ]);
});

test("doctor reports a saved choice and the profile override or shell window", () => {
  const config = sampleConfig({ maxContextTokens: 150000, subagentModel: TIERS.haiku });
  const catalog = resolveCatalog(config, rows);
  const profile = sessionModel(config, catalog, {}, "sonnet", undefined);
  const shell = sessionModel(
    config,
    catalog,
    { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" },
    "sonnet",
    undefined,
  );
  expect(checkEffectiveModel(config, catalog, profile)[0]?.title).toContain(
    "150000 tokens (profile override)",
  );
  const title = checkEffectiveModel(config, catalog, shell)[0]?.title;
  expect(title).toContain(`model=${TIERS.sonnet}, subagentModel=${TIERS.haiku}`);
  expect(title).toContain("180000 tokens (shell)");
});

test("doctor warns for an unserved subagent without disclosing credential fragments", () => {
  const config = sampleConfig({ subagentModel: KEY.slice(-8) });
  const snapshot = structuredClone(config);
  const catalog = resolveCatalog(config, rows);
  const model = sessionModel(config, catalog, {}, undefined, undefined);
  const results = checkEffectiveModel(config, catalog, model, "work");
  expect(results[0]?.title).toContain("subagentModel=(withheld)");
  expect(results[1]).toMatchObject({ status: "WARN", fix: expect.stringContaining("work") });
  assertNoKeyFragment(JSON.stringify(results), KEY);
  expect(config).toEqual(snapshot);
});

test("an empty successful catalog is different from an unavailable catalog", () => {
  const config = sampleConfig({ subagentModel: TIERS.haiku });
  for (const rows of [[], undefined]) {
    const catalog = resolveCatalog(config, rows);
    const model = sessionModel(config, catalog, {}, undefined, undefined);
    const results = checkEffectiveModel(config, catalog, model);
    expect(results.some(({ status }) => status === "WARN")).toBe(rows !== undefined);
  }
});
