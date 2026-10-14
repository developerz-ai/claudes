import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./schema";
import { ConfigError, InsecureConfigError, readConfig, writeConfig } from "./store";

let dir: string;
let path: string;

function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: "https://router.example.test",
    key: "mar_live_TESTKEYabcdef012345",
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudes-store-"));
  path = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeConfig", () => {
  test("creates the dir 0700 and the file 0600, and round-trips", () => {
    const config = sampleConfig();
    writeConfig(path, config);
    const fileStat = statSync(path);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readConfig(path)).toEqual(config);
  });

  test("creates a missing config dir with 0700", () => {
    const nested = join(dir, "claudes");
    writeConfig(join(nested, "config.json"), sampleConfig());
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  test("tightens an existing loose dir to 0700", () => {
    const nested = join(dir, "claudes");
    const nestedPath = join(nested, "config.json");
    writeConfig(nestedPath, sampleConfig());
    chmodSync(nested, 0o777);
    writeConfig(nestedPath, sampleConfig({ key: "mar_live_SECONDKEYabcdef01" }));
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  test("refuses to write a config the schema rejects", () => {
    const bad = { ...sampleConfig(), baseUrl: "http://not-loopback.example.com" } as Config;
    expect(() => writeConfig(path, bad)).toThrow(ConfigError);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("an interrupted write keeps the previous config and leaves no temp file", () => {
    writeConfig(path, sampleConfig());
    const updated = sampleConfig({ key: "mar_live_SECONDKEYabcdef01" });
    expect(() =>
      writeConfig(path, updated, {
        afterTempWrite: () => {
          throw new Error("simulated crash between temp write and rename");
        },
      }),
    ).toThrow("simulated crash between temp write and rename");
    expect(readConfig(path)).toEqual(sampleConfig());
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});

describe("readConfig", () => {
  test("refuses a group/other-readable file with the exact chmod 600 fix", () => {
    writeConfig(path, sampleConfig());
    chmodSync(path, 0o644);
    try {
      readConfig(path);
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      expect((err as InsecureConfigError).message).toContain(`chmod 600 ${path}`);
    }
  });

  test("refuses a file owned by another uid", () => {
    writeConfig(path, sampleConfig());
    try {
      readConfig(path, { getuid: () => 12345 });
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      expect((err as InsecureConfigError).message).toContain("owned by uid");
    }
  });

  test("refuses a config dir with group/other bits, with the chmod 700 fix", () => {
    writeConfig(path, sampleConfig());
    chmodSync(dir, 0o750);
    try {
      readConfig(path);
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      expect((err as InsecureConfigError).message).toContain(`chmod 700 ${dir}`);
    }
  });

  test("explains that a missing config means running login", () => {
    try {
      readConfig(join(dir, "absent.json"));
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('run "claudes login" first');
    }
  });

  test("refuses invalid JSON and schema-invalid payloads", () => {
    const writeRaw = (text: string) => {
      const fd = openSync(path, "w", 0o600);
      writeSync(fd, text);
      closeSync(fd);
    };
    writeRaw("this is not json");
    expect(() => readConfig(path)).toThrow("is not valid JSON");
    writeRaw('{"version": 2}');
    expect(() => readConfig(path)).toThrow("not a valid claudes config");
  });
});
