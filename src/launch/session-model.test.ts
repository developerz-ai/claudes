import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCatalog } from "./catalog";
import { buildChildEnv, WINDOW_MARKER, WINDOW_VARS } from "./env";
import { sampleConfig } from "./run-harness";
import { explicitModel, readSavedModel, sessionModel } from "./session-model";

const [auto, max] = WINDOW_VARS;
const config = sampleConfig({ pins: {} });
const catalog = resolveCatalog(config, [
  { id: "claude-opus-4-6", contextTokens: 128000 },
  { id: "provider/custom", contextTokens: 96000 },
  { id: "provider/unknown" },
]);

test("session model preserves valid choices and pins opus only over an unserved saved choice", () => {
  for (const saved of [undefined, "opus[1m]", "provider/custom"]) {
    expect(sessionModel(config, catalog, {}, saved, undefined).model).toBeUndefined();
  }
  const foreign = sessionModel(config, catalog, {}, "unserved", undefined);
  expect(foreign.model).toBe("opus");
  expect(foreign.env.ANTHROPIC_MODEL).toBe("");
  expect(foreign.notes).toHaveLength(1);
  const explicit = sessionModel(config, catalog, {}, "unserved", "another-unlisted-id");
  expect(explicit.model).toBeUndefined();
  expect(explicit.notes).toContain(
    "the requested --model is not in the live catalog; passing it through",
  );
  expect(
    explicitModel(["--model", "opus", "--model=provider/custom", "--", "--model=ignored"]),
  ).toBe("provider/custom");
});

test("context windows preserve shell settings and replace generated values in nested sessions", () => {
  const tier = sessionModel(config, catalog, {}, "opus[1m]", undefined);
  expect(tier.env).toMatchObject({ [auto]: "128000", [max]: "96000" });
  expect(buildChildEnv(tier.env)[auto]).toBeUndefined();
  expect(buildChildEnv(tier.env)[max]).toBeUndefined();
  const custom = sessionModel(config, catalog, tier.env, undefined, "provider/custom");
  expect(custom.env).toMatchObject({ [auto]: "96000", [max]: "96000" });
  const unknown = sessionModel(config, catalog, {}, undefined, "provider/unknown");
  expect(unknown.env[auto]).toBeUndefined();
  expect(unknown.env[max]).toBeUndefined();
  const override = sessionModel(
    { ...config, maxContextTokens: 150000 },
    catalog,
    { [max]: "200000" },
    undefined,
    undefined,
  );
  expect(override.env).toMatchObject({ [auto]: "150000", [max]: "200000", [WINDOW_MARKER]: auto });
  expect(buildChildEnv(override.env)[max]).toBe("200000");
});

test("reads the configured user settings without writing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudes-model-"));
  try {
    const env = { CLAUDE_CONFIG_DIR: dir, HOME: "/missing" };
    const path = join(dir, "settings.json");
    expect(readSavedModel(env)).toBeUndefined();
    mkdirSync(path);
    expect(readSavedModel(env)).toBeUndefined();
    rmSync(path, { recursive: true });
    writeFileSync(path, "broken JSON");
    expect(readSavedModel(env)).toBeUndefined();
    writeFileSync(path, '{"model":"provider/custom"}');
    expect(readSavedModel(env)).toBe("provider/custom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
