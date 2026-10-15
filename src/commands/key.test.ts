import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configDir, configFile } from "../config/paths";
import type { Config } from "../config/schema";
import { writeConfig } from "../config/store";
import { BENIGN_USE_TOGGLES, PROVIDER_SWITCHES } from "../launch/provider-switches";
import { assertNoKeyFragment } from "../test-support/redact";
import { runKey } from "./key";

const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";
const ROUTER = "https://router.example.test";

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
    baseUrl: ROUTER,
    key: KEY,
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
  };
}

function drive(stdoutIsTTY: boolean, env: Record<string, string | undefined> = {}): number {
  return runKey({
    env: { HOME: home, ...env },
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

  test("refuses a truthy provider switch with exit 64, before any config is read", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    const code = drive(false, { CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(code).toBe(64);
    // The variable is named; its value never is.
    expect(err).toEqual([
      "claudes key: refusing: CLAUDE_CODE_USE_BEDROCK is set, so this session would not go to the router\n",
    ]);
    expect(writes).toEqual([]);
  });

  test("refuses any provider switch, naming only the variable", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    for (const name of PROVIDER_SWITCHES) {
      err = [];
      writes = [];
      expect(drive(false, { [name]: "true" })).toBe(64);
      expect(err.join("")).toBe(
        `claudes key: refusing: ${name} is set, so this session would not go to the router\n`,
      );
      expect(writes).toEqual([]);
    }
  });

  test("a switch set to a falsy value does not trigger the refusal", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    for (const value of ["", "0", "false", "FALSE", "False"]) {
      expect(drive(false, { CLAUDE_CODE_USE_VERTEX: value })).toBe(0);
    }
    expect(writes).toEqual([KEY, KEY, KEY, KEY, KEY]);
    expect(err).toEqual([]);
  });

  test("refuses the gateway switch", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    expect(drive(false, { CLAUDE_CODE_USE_GATEWAY: "1" })).toBe(64);
    expect(err.join("")).toBe(
      "claudes key: refusing: CLAUDE_CODE_USE_GATEWAY is set, so this session would not go to the router\n",
    );
    expect(writes).toEqual([]);
  });

  test("refuses an unknown CLAUDE_CODE_USE_ toggle, naming only the variable", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    expect(drive(false, { CLAUDE_CODE_USE_FUTURE_THING: "1" })).toBe(64);
    expect(err.join("")).toBe(
      "claudes key: refusing: CLAUDE_CODE_USE_FUTURE_THING is set, so this session would not go to the router\n",
    );
    expect(writes).toEqual([]);
    assertNoKeyFragment(err.join(""), KEY);
  });

  test("allows the benign CLAUDE_CODE_USE_ toggles", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    for (const name of BENIGN_USE_TOGGLES) {
      err = [];
      writes = [];
      expect(drive(false, { [name]: "1" })).toBe(0);
      expect(writes).toEqual([KEY]);
      expect(err).toEqual([]);
    }
  });

  test("refuses when ANTHROPIC_BASE_URL points anywhere but the configured router", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    for (const value of [
      "https://elsewhere.example.test",
      "https://router.example.test:8443",
      "not a url",
    ]) {
      err = [];
      writes = [];
      expect(drive(false, { ANTHROPIC_BASE_URL: value })).toBe(64);
      expect(err.join("")).toBe(
        "claudes key: refusing: ANTHROPIC_BASE_URL does not point at the configured router\n",
      );
      expect(writes).toEqual([]);
      assertNoKeyFragment(err.join(""), KEY);
    }
  });

  test("allows an ANTHROPIC_BASE_URL matching the router, trailing slash included", () => {
    writeConfig(configFile(configDir({ HOME: home })), config());
    for (const value of [undefined, "", ROUTER, `${ROUTER}/`]) {
      err = [];
      writes = [];
      expect(drive(false, { ANTHROPIC_BASE_URL: value })).toBe(0);
      expect(writes).toEqual([KEY]);
      expect(err).toEqual([]);
    }
  });

  test("the refusal fires even with no config at all", () => {
    expect(drive(false, { CLAUDE_CODE_USE_FOUNDRY: "yes" })).toBe(64);
    expect(err.join("")).toContain("CLAUDE_CODE_USE_FOUNDRY is set");
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
