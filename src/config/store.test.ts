import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
    key: "mar_live_TESTKEYabcdef0123456789abcdefghi",
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
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
    writeConfig(nestedPath, sampleConfig({ key: "mar_live_SECONDKEYabcdef0123456789abcdefg" }));
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  test("refuses to write a config the schema rejects", () => {
    const bad = { ...sampleConfig(), baseUrl: "http://not-loopback.example.com" } as Config;
    expect(() => writeConfig(path, bad)).toThrow(ConfigError);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses a symlinked config dir before chmodding its target", () => {
    const target = join(dir, "target");
    mkdirSync(target);
    chmodSync(target, 0o755); // deliberately loose, so a chmod would be visible
    const link = join(dir, "link");
    symlinkSync(target, link);
    expect(() => writeConfig(join(link, "config.json"), sampleConfig())).toThrow(
      `${link} is a symbolic link`,
    );
    // The chmod never ran: the target still carries group/other read bits.
    expect(statSync(target).mode & 0o077).not.toBe(0);
    expect(readdirSync(target)).toEqual([]);
  });

  test("an interrupted write keeps the previous config and leaves no temp file", () => {
    writeConfig(path, sampleConfig());
    const updated = sampleConfig({ key: "mar_live_SECONDKEYabcdef0123456789abcdefg" });
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

  test("a short write throws, keeps the previous config, and cleans the temp file", () => {
    writeConfig(path, sampleConfig());
    const updated = sampleConfig({ key: "mar_live_SECONDKEYabcdef0123456789abcdefg" });
    expect(() =>
      writeConfig(path, updated, {
        // Simulates a partial write: only half the payload reaches the fd.
        writeFile: (fd, payload) => {
          const bytes = Buffer.from(payload, "utf8");
          writeSync(fd, bytes.subarray(0, Math.floor(bytes.length / 2)));
        },
      }),
    ).toThrow("short write");
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

  test("refuses a file owned by another uid, saying to re-run login", () => {
    writeConfig(path, sampleConfig());
    try {
      readConfig(path, { getuid: () => 12345 });
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      expect((err as InsecureConfigError).message).toContain("owned by uid");
      expect((err as InsecureConfigError).message).toContain('run "claudes login"');
      expect((err as InsecureConfigError).message).not.toContain("chmod");
    }
  });

  test("checks ownership before permissions: a foreign-uid, world-readable file gets the uid message", () => {
    writeConfig(path, sampleConfig());
    chmodSync(path, 0o666);
    try {
      readConfig(path, { getuid: () => 12345 });
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      expect((err as InsecureConfigError).message).toContain("owned by uid");
      expect((err as InsecureConfigError).message).not.toContain("chmod 600");
    }
  });

  test("refuses a symlinked config without following it", () => {
    writeConfig(path, sampleConfig());
    const victim = join(dir, "victim.json");
    writeConfig(victim, sampleConfig({ key: "mar_live_VICTIMKEYabcdef0123456789bcdefgh" }));
    const link = join(dir, "link.json");
    symlinkSync(victim, link);
    try {
      readConfig(link);
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      expect((err as InsecureConfigError).message).toContain("symbolic link");
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

  test("refuses a config dir owned by another uid, saying to remove it, not chmod", () => {
    writeConfig(path, sampleConfig());
    try {
      readConfig(path, { getuid: () => 12345 });
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(InsecureConfigError);
      const message = (err as InsecureConfigError).message;
      expect(message).toContain(`directory ${dir} is owned by uid`);
      expect(message).toContain('remove it and re-run "claudes login"');
      expect(message).not.toContain("chmod");
    }
  });

  test("wraps every other open/stat errno in ConfigError with the path and a fix", () => {
    // EACCES on the open: an unreadable file inside a readable dir.
    writeConfig(path, sampleConfig());
    chmodSync(path, 0o000);
    try {
      readConfig(path);
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain(`cannot read config at ${path} (EACCES)`);
      expect(message).toContain('remove it and re-run "claudes login"');
    } finally {
      chmodSync(path, 0o600);
    }

    // ENOTDIR on the open: a plain file where a config-dir component should be
    // (the dir stat sees the plain file and succeeds, the open cannot).
    const notDir = join(dir, "plainfile");
    const fd = openSync(notDir, "w", 0o600);
    closeSync(fd);
    try {
      readConfig(join(notDir, "config.json"));
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain(`cannot read config at ${join(notDir, "config.json")} (ENOTDIR)`);
      expect(message).toContain('remove it and re-run "claudes login"');
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

  test("refuses a directory at the config path with the exact message", () => {
    const asDir = join(dir, "asdir");
    mkdirSync(asDir);
    try {
      readConfig(asDir);
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toBe(
        `config path ${asDir} is a directory, not a file — remove it and re-run "claudes login"`,
      );
      expect(message).not.toContain("chmod");
    }
  });

  test("refuses a FIFO at the config path instead of hanging on the open", () => {
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    try {
      readConfig(fifo);
      throw new Error("expected readConfig to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(
        `config path ${fifo} is not a regular file — remove it and re-run "claudes login"`,
      );
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
