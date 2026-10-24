import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY, ROUTER } from "../test-support/fixtures";
import { assertNoKeyFragment } from "../test-support/redact";
import { loadConfig, MISSING_CONFIG_MESSAGE } from "./load";
import { configDir, configFile } from "./paths";
import type { Config } from "./schema";
import { writeConfig } from "./store";

function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: ROUTER,
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
    const result = loadConfig({ HOME: home });
    expect(result).toEqual({
      ok: false,
      exitCode: 78,
      message: MISSING_CONFIG_MESSAGE,
    });
    if (!result.ok) {
      assertNoKeyFragment(result.message, KEY);
    }
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

  test("a dangling config symlink: replacement remedy and exit 78, not missing config", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    symlinkSync(join(dir, "missing-target.json"), path);

    const result = loadConfig({ HOME: home });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(78);
      expect(result.message).toContain("is a symbolic link");
      expect(result.message).toContain('run "claudes login" again to replace it');
      expect(result.message).not.toBe(MISSING_CONFIG_MESSAGE);
      assertNoKeyFragment(result.message, KEY);
    }
  });

  test("a non-directory ancestor: directory diagnostic and exit 78, not missing config", () => {
    const ancestor = join(home, "not-a-directory");
    writeFileSync(ancestor, "", { mode: 0o600 });
    const xdg = join(ancestor, "config");
    const blockedDir = configDir({ XDG_CONFIG_HOME: xdg });

    const result = loadConfig({ XDG_CONFIG_HOME: xdg });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(78);
      expect(result.message).toContain(`cannot read the config directory ${blockedDir} (ENOTDIR)`);
      expect(result.message).toContain('remove it and re-run "claudes login"');
      expect(result.message).not.toBe(MISSING_CONFIG_MESSAGE);
      assertNoKeyFragment(result.message, KEY);
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
