import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, profileFile } from "../config/paths";
import { readConfig, writeConfig } from "../config/store";
import { assertNoKeyFragment } from "../test-support/redact";
import { login } from "./login";
import { configPath, harness, KEY, ROUTER } from "./login-harness";
import { InputTooLongError, StdinClosedError } from "./login-input";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-login-env-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("login environment", () => {
  const refusal =
    "claudes login: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed";
  const truthyValues = ["1", "true", "TRUE", "yes", " ", "login-secret-sentinel-927", KEY];
  const falsyValues = [undefined, "", "0", "false", "FALSE", "False"];

  for (const stdinIsTTY of [false, true]) {
    for (const [index, value] of truthyValues.entries()) {
      test(`verbose fetch refuses before I/O (TTY=${stdinIsTTY}, case ${index})`, async () => {
        const h = harness(home, {
          env: { HOME: home, BUN_CONFIG_VERBOSE_FETCH: value },
          stdinIsTTY,
          ttyKey: KEY,
        });
        let secretReads = 0;
        let stdinReads = 0;
        const result = await login(["--url", ROUTER], {
          ...h.deps,
          readSecret: async (prompt) => {
            secretReads++;
            return h.deps.readSecret(prompt);
          },
          readStdinLine: async () => {
            stdinReads++;
            return h.deps.readStdinLine();
          },
        });
        expect(result).toEqual({ ok: false, exitCode: 64, message: refusal });
        expect(h.stdout).toEqual([]);
        expect(h.prompts).toEqual([]);
        expect(secretReads).toBe(0);
        expect(stdinReads).toBe(0);
        expect(h.fetchCalls).toEqual([]);
        expect(h.writeConfigCalls).toEqual([]);
        expect(existsSync(configPath(home))).toBe(false);
        const output = `${result.ok ? "" : result.message}\n${h.stdout.join("\n")}`;
        assertNoKeyFragment(output, KEY);
        if (value !== " ") {
          expect(output).not.toContain(value);
        }
      });
    }

    for (const [index, value] of falsyValues.entries()) {
      test(`verbose fetch off retains login (TTY=${stdinIsTTY}, case ${index})`, async () => {
        const h = harness(home, {
          env: { HOME: home, BUN_CONFIG_VERBOSE_FETCH: value },
          stdinIsTTY,
          ttyKey: KEY,
        });
        const result = await login(["--url", ROUTER], h.deps);
        expect(result.ok).toBe(true);
        expect(h.fetchCalls).toEqual([`${ROUTER}/healthz`, `${ROUTER}/v1/models`]);
        expect(h.writeConfigCalls).toHaveLength(1);
        expect(h.stdout.join("\n")).toContain("sonnet claude-sonnet-4-5");
        assertNoKeyFragment(h.stdout.join("\n"), KEY);
      });
    }
  }

  test("verbose fetch refusal precedes config resolution", async () => {
    const h = harness(home, { env: { BUN_CONFIG_VERBOSE_FETCH: "1" } });
    expect(await login(["--url", ROUTER], h.deps)).toEqual({
      ok: false,
      exitCode: 64,
      message: refusal,
    });
    expect(h.fetchCalls).toEqual([]);
    expect(h.writeConfigCalls).toEqual([]);
  });

  test("argv errors take precedence over verbose fetch refusal", async () => {
    const h = harness(home, { env: { BUN_CONFIG_VERBOSE_FETCH: KEY } });
    const result = await login([], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok ? "" : (result.message ?? "");
    expect(message).toContain("usage: claudes login [--profile <name>] [--url");
    expect(message).not.toContain("BUN_CONFIG_VERBOSE_FETCH");
    assertNoKeyFragment(`${message}\n${h.stdout.join("\n")}`, KEY);
    expect(h.fetchCalls).toEqual([]);
    expect(h.writeConfigCalls).toEqual([]);
  });

  test("resolves the config path first: no HOME means exit 78 before any prompt or fetch", async () => {
    const h = harness(home, { env: {} });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 78 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("cannot find the config directory");
    expect(message).toContain("set $HOME or $XDG_CONFIG_HOME to an absolute path");
    expect(message.split("\n").length).toBe(1); // one line, no stack trace
    expect(h.prompts).toEqual([]);
    expect(h.fetchCalls).toEqual([]);
    expect(existsSync(configPath(home))).toBe(false);
  });

  test("a stream error while reading the key exits 1 with a clean one-line message", async () => {
    const h = harness(home, { stdinError: new Error("EPIPE: broken pipe") });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("could not read the key from stdin");
    expect(message.split("\n").length).toBe(1); // one line, no stack trace
  });

  test("stdin closing under the TTY prompt exits 1 with one line, not a silent 130", async () => {
    const h = harness(home, { stdinIsTTY: true, ttyError: new StdinClosedError() });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toBe("claudes login: stdin closed");
    expect(h.fetchCalls).toEqual([]);
    expect(existsSync(configPath(home))).toBe(false);
  });

  test("more than 4096 bytes of piped input exits 64 with no echo of the input", async () => {
    const h = harness(home, { stdinError: new InputTooLongError() });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toBe(
      "claudes login: input too long for a router key",
    );
    expect(h.fetchCalls).toEqual([]);
    expect(existsSync(configPath(home))).toBe(false);
  });

  test("more than 4096 bytes typed at the prompt exits 64 the same way", async () => {
    const h = harness(home, { stdinIsTTY: true, ttyError: new InputTooLongError() });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toBe(
      "claudes login: input too long for a router key",
    );
  });
});

describe("login key acquisition", () => {
  test("non-TTY: reads the first line of stdin and trims it", async () => {
    const h = harness(home, { stdin: `${KEY}\r\nsecond-line-ignored` });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.writeConfigCalls[0]?.config).toMatchObject({ key: KEY });
  });

  test("non-TTY: an empty stdin is a usage error", async () => {
    const h = harness(home, { stdin: "" });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toContain("no router key provided");
  });

  test("a key without the mar_live_ prefix is refused", async () => {
    const h = harness(home, { stdin: "sk-something-else" });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).not.toContain("sk-something-else");
  });

  const MALFORMED_KEYS: [string, string][] = [
    [`mar_live_${"A".repeat(31)}\0`, "an embedded NUL byte"],
    [`mar_live_${"A".repeat(31)}\r`, "a carriage return"],
    [`mar_live_${"A".repeat(31)}\t`, "a tab"],
    [`mar_live_${"A".repeat(16)} ${"A".repeat(15)}`, "an inner space"],
    [`mar_live_${"A".repeat(16)}é${"A".repeat(15)}`, "a non-ASCII character"],
    [`mar_live_${"A".repeat(31)}`, "one character too short"],
    [`mar_live_${"A".repeat(33)}`, "one character too long"],
  ];

  for (const [badKey, why] of MALFORMED_KEYS) {
    test(`never calls fetch for a malformed key (${why})`, async () => {
      const h = harness(home, { stdin: badKey });
      const result = await login(["--url", ROUTER], h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      expect(h.fetchCalls).toEqual([]);
      expect(existsSync(configPath(home))).toBe(false);
      // The refusal is a fixed sentence: no part of the input is echoed back,
      // and the worded prefix comes through scrub() intact and natural.
      expect(result.ok === false && result.message).toBe(
        "claudes login: that is not a valid router key (expected the mar_live_… prefix followed by 32 characters)",
      );
    });
  }

  test("TTY: prompts once and never echoes the key", async () => {
    const h = harness(home, { stdinIsTTY: true, ttyKey: KEY });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.prompts).toEqual(["Router key: "]);
    expect(h.stdout.join("")).not.toContain(KEY);
  });

  test("TTY: Ctrl-C aborts with exit 130 and writes nothing", async () => {
    const h = harness(home, { stdinIsTTY: true, ttyKey: undefined });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 130 });
    expect(h.stdout).toEqual([]);
    expect(existsSync(configPath(home))).toBe(false);
  });
});

test("re-login without a URL preserves profile settings and can clear a pin", async () => {
  const dir = configDir({ HOME: home });
  const path = profileFile(dir, "work");
  const h = harness(home, { realStore: true, stdin: KEY });
  expect((await login(["--profile", "work"], h.deps)).ok).toBe(false);
  expect((await login(["--profile", "work", "--url", ROUTER], h.deps)).ok).toBe(true);
  writeConfig(path, {
    ...readConfig(path),
    pins: { opus: "claude-opus-1", haiku: "claude-haiku-1" },
    subagentModel: "claude-sonnet-4-6",
    maxContextTokens: 150000,
  });
  expect((await login(["--profile", "work", "--haiku", "auto"], h.deps)).ok).toBe(true);
  expect(readConfig(path)).toMatchObject({
    baseUrl: ROUTER,
    pins: { opus: "claude-opus-1" },
    tiers: { opus: "claude-opus-1", haiku: "claude-haiku-4-5" },
    subagentModel: "claude-sonnet-4-6",
    maxContextTokens: 150000,
  });
  expect(readConfig(path).pins?.haiku).toBeUndefined();
  expect(existsSync(configPath(home))).toBe(false);
  assertNoKeyFragment(h.stdout.join("\n"), KEY);
});

test("concurrent logins to different profiles preserve both configs", async () => {
  const h = harness(home, { realStore: true, stdin: KEY });
  const dir = configDir({ HOME: home });
  const results = await Promise.all(
    ["work", "personal"].map((name) => login(["--profile", name, "--url", ROUTER], h.deps)),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  for (const name of ["work", "personal"]) {
    expect(readConfig(profileFile(dir, name)).baseUrl).toBe(ROUTER);
  }
});

test("legacy migration reports no fragment of the replaced credential", async () => {
  const previousKey = `mar_live_${"w".repeat(32)}`;
  writeConfig(configPath(home), {
    version: 1,
    baseUrl: ROUTER,
    key: previousKey,
    tiers: {
      opus: `claude-opus-${previousKey.slice(-8)}`,
      sonnet: "claude-sonnet-1",
      haiku: "claude-haiku-1",
    },
  });
  const h = harness(home, { realStore: true, stdin: KEY });
  expect((await login([], h.deps)).ok).toBe(true);
  const output = h.stdout.join("\n");
  expect(output).toContain("(details withheld)");
  assertNoKeyFragment(output, previousKey);
  assertNoKeyFragment(output, KEY);
});
