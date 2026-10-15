import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configDir, configFile } from "../config/paths";
import type { Config } from "../config/schema";
import { writeConfig } from "../config/store";
import { assertNoKeyFragment } from "../test-support/redact";
import { runKey } from "./key";

const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

let home: string;
let err: string[];
let writes: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-key-"));
  err = [];
  writes = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function config(): Config {
  return {
    version: 1,
    baseUrl: "https://router.example.test",
    key: KEY,
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
  };
}

function drive(stdoutIsTTY: boolean): number {
  return runKey({
    env: { HOME: home },
    stdoutIsTTY,
    write: (text) => writes.push(text),
    stderr: (text) => err.push(text),
  });
}

describe("runKey", () => {
  test("refuses a TTY stdout with exit 64 and the helper-only message", () => {
    const code = drive(true);
    expect(code).toBe(64);
    expect(err).toEqual(["claudes key is for apiKeyHelper only\n"]);
    expect(writes).toEqual([]);
  });

  test("under a pipe it writes the key, and nothing else, with no newline", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    const code = drive(false);
    expect(code).toBe(0);
    expect(writes).toEqual([KEY]);
    expect(writes.join("")).toBe(KEY);
    expect(err).toEqual([]);
  });

  test("no config: exit 78 with the login remedy, nothing written", () => {
    const code = drive(false);
    expect(code).toBe(78);
    expect(err).toEqual([`${MISSING_CONFIG_MESSAGE}\n`]);
    expect(writes).toEqual([]);
  });

  test("insecure config perms are refused by the store, exit 78", () => {
    const path = configFile(configDir({ HOME: home }));
    writeConfig(path, config());
    chmodSync(path, 0o644);
    const code = drive(false);
    expect(code).toBe(78);
    expect(err.join("")).toContain("readable by group or other users");
    expect(writes).toEqual([]);
  });

  test("an unparsable config: exit 78 with the store's message, nothing written", () => {
    const path = configFile(configDir({ HOME: home }));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json", "utf8");
    chmodSync(path, 0o600);
    const code = drive(false);
    expect(code).toBe(78);
    expect(err.join("")).toContain("is not valid JSON");
    expect(writes).toEqual([]);
  });

  test("no error path leaks the key", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    drive(true);
    drive(false);
    rmSync(home, { recursive: true, force: true });
    drive(false);
    assertNoKeyFragment(err.join(""), KEY);
  });
});
