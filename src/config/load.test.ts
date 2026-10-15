import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoKeyFragment } from "../test-support/redact";
import { loadConfig, MISSING_CONFIG_MESSAGE } from "./load";
import { configDir, configFile } from "./paths";
import type { Config } from "./schema";
import { writeConfig } from "./store";

const KEY = "mar_live_TESTKEYabcdef0123456789abcdefghi";

function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: "https://router.example.test",
    key: KEY,
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    ...overrides,
  };
}

let home: string;
let dir: string;
let path: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-load-"));
  dir = configDir({ HOME: home });
  path = configFile(dir);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("no config yet: the missing-config remedy and exit 78", () => {
    expect(loadConfig({ HOME: home })).toEqual({
      ok: false,
      exitCode: 78,
      message: MISSING_CONFIG_MESSAGE,
    });
  });

  test("no usable HOME or XDG_CONFIG_HOME is also just a missing config", () => {
    for (const env of [{}, { HOME: "relative" }, { XDG_CONFIG_HOME: "relative" }] as const) {
      expect(loadConfig(env)).toEqual({
        ok: false,
        exitCode: 78,
        message: MISSING_CONFIG_MESSAGE,
      });
    }
  });

  test("a config the store refuses (a 0644 file): the store's message, exit 78", () => {
    writeConfig(path, sampleConfig());
    chmodSync(path, 0o644);
    const result = loadConfig({ HOME: home });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(78);
      expect(result.message).toContain(`chmod 600 ${path}`);
      expect(result.message).not.toBe(MISSING_CONFIG_MESSAGE);
      assertNoKeyFragment(result.message, KEY);
    }
  });

  test("a healthy config: ok with the parsed config and its directory", () => {
    writeConfig(path, sampleConfig());
    expect(loadConfig({ HOME: home })).toEqual({ ok: true, config: sampleConfig(), dir });
  });

  test("XDG_CONFIG_HOME wins over HOME", () => {
    const xdg = mkdtempSync(join(tmpdir(), "claudes-load-xdg-"));
    try {
      const xdgDir = configDir({ XDG_CONFIG_HOME: xdg });
      writeConfig(configFile(xdgDir), sampleConfig());
      const result = loadConfig({ HOME: home, XDG_CONFIG_HOME: xdg });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.dir).toBe(xdgDir);
      }
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
