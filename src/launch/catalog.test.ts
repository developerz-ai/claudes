import { expect, test } from "bun:test";
import { resolveCatalog } from "./catalog";
import { sampleConfig } from "./run-harness";

test("catalog pins served entries, drops covered aliases and replaces removed tiers", () => {
  const result = resolveCatalog(
    sampleConfig({
      pins: { sonnet: "claude-sonnet-4-5", opus: "claude-opus-5-5" },
    }),
    [
      { id: "claude-sonnet-4-6" },
      {
        id: "claude-sonnet-4-5",
        displayName: "Pinned",
        contextTokens: 128000,
        maxOutputTokens: 16000,
      },
      { id: "claude-sonnet", resolvedModel: "claude-sonnet-4-5" },
      { id: "claude-fable-5-2" },
      { id: "provider/custom" },
    ],
  );
  expect(result.tiers).toEqual({
    opus: "claude-sonnet-4-5",
    sonnet: "claude-sonnet-4-5",
    haiku: "claude-sonnet-4-5",
    fable: "claude-fable-5-2",
  });
  expect(result.picker).toEqual([
    { model: "claude-sonnet-4-5", label: "Pinned", description: "128K context · 16K output" },
    { model: "claude-fable-5-2", label: "claude-fable-5-2" },
    { model: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    { model: "provider/custom", label: "provider/custom" },
  ]);
  expect(result.notes).toContain(
    "the opus pin is not served; choosing a model from the live catalog",
  );
});

test("a previous config treats its served snapshot as pins until re-login", () => {
  const config = sampleConfig({ pins: undefined });
  const rows = Object.values(config.tiers).map((id) => ({ id }));
  rows.push({ id: "claude-opus-6-0" });
  expect(resolveCatalog(config, rows).tiers.opus).toBe(config.tiers.opus);
  expect(resolveCatalog({ ...config, pins: {} }, rows).tiers.opus).toBe("claude-opus-6-0");
});

test("the catalog can route non-Claude models and falls back on listing failure", () => {
  const config = sampleConfig({ pins: {} });
  const live = resolveCatalog(config, [{ id: "provider/z" }, { id: "provider/a" }]);
  expect(live.tiers).toEqual({ opus: "provider/a", sonnet: "provider/a", haiku: "provider/a" });
  const offline = resolveCatalog(config);
  expect(offline.picker).toEqual([]);
  expect(offline.tiers).toEqual(config.tiers);
  expect(offline.notes).toContain("the model list is not live; using the stored tier snapshot");
});
