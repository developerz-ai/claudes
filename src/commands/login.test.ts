import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("resolves the config path first: no HOME means exit 78 before any prompt or fetch", async () => {
    const h = harness(home, { env: {} });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 78 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("cannot find the config directory");
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

  test("TTY: prompts on stderr and never echoes the key", async () => {
    const h = harness(home, { stdinIsTTY: true, ttyKey: KEY });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.prompts).toEqual(["Router key: "]);
    expect(h.stderr.join("")).toContain("Router key: ");
    expect(h.stderr.join("")).not.toContain(KEY);
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
