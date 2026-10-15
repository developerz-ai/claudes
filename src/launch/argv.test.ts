import { describe, expect, test } from "bun:test";
import { buildArgv } from "./argv";

const SETTINGS = "/home/dev/.config/claudes/settings.json";
const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

describe("buildArgv", () => {
  test("prepends --settings with the generated settings path", () => {
    expect(buildArgv(["-p", "fix the bug"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "-p", "fix the bug"],
    });
    expect(buildArgv([], SETTINGS)).toEqual({ ok: true, argv: ["--settings", SETTINGS] });
  });

  test("maps claude-* model aliases to the bare family name", () => {
    expect(buildArgv(["--model", "claude-opus"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "opus"],
    });
    expect(buildArgv(["--model", "claude-sonnet"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "sonnet"],
    });
    expect(buildArgv(["--model", "claude-haiku"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "haiku"],
    });
    expect(buildArgv(["--model=claude-opus"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "opus"],
    });
  });

  test("leaves other --model values alone", () => {
    expect(buildArgv(["--model", "opus"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "opus"],
    });
    expect(buildArgv(["--model", "some-router-id"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "some-router-id"],
    });
    // A dangling flag passes through; claude reports it itself.
    expect(buildArgv(["--model"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model"],
    });
  });

  test("passes prototype-born --model values through unchanged, as strings", () => {
    // "toString" and "__proto__" resolve on the alias table's prototype chain;
    // only own properties may map, or a function/object would land in argv.
    for (const value of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      const result = buildArgv(["--model", value], SETTINGS);
      expect(result).toEqual({ ok: true, argv: ["--settings", SETTINGS, "--model", value] });
      expect(result.ok && typeof result.argv[2]).toBe("string");
    }
  });

  test("maps a claude-* alias with an [1m] suffix, keeping the suffix", () => {
    expect(buildArgv(["--model", "claude-opus[1m]"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "opus[1m]"],
    });
    expect(buildArgv(["--model=claude-sonnet[1m]"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "sonnet[1m]"],
    });
    expect(buildArgv(["--model", "claude-haiku[1m]"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "haiku[1m]"],
    });
    // The suffix alone, or on an unknown base, is not an alias.
    expect(buildArgv(["--model", "[1m]"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "[1m]"],
    });
    expect(buildArgv(["--model", "other-model[1m]"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--model", "other-model[1m]"],
    });
  });

  test("stops scanning and rewriting at a -- terminator", () => {
    expect(buildArgv(["--", "--settings", "/tmp/mine.json"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--", "--settings", "/tmp/mine.json"],
    });
    expect(buildArgv(["-p", "--", "--model", "claude-opus"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "-p", "--", "--model", "claude-opus"],
    });
    expect(buildArgv(["--", "--key", "k"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "--", "--key", "k"],
    });
  });

  test("refuses a user --settings in both forms, without echoing the value", () => {
    for (const args of [["--settings", "/tmp/mine.json"], ["--settings=/tmp/mine.json"]]) {
      const result = buildArgv(args, SETTINGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(64);
        expect(result.message).toContain("--settings is not supported");
        expect(result.message).not.toContain("/tmp/mine.json");
      }
    }
  });

  test("refuses a user --key in both forms, without echoing the value", () => {
    for (const args of [["--key", "whatev"], ["--key=whatev"]]) {
      const result = buildArgv(args, SETTINGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(64);
        expect(result.message).toContain("--key is not supported");
        expect(result.message).not.toContain("whatev");
      }
    }
  });

  test("refuses a router key anywhere in argv, without echoing it", () => {
    for (const args of [["-p", KEY], [KEY], [`--flag=${KEY}`], ["--model", KEY]]) {
      const result = buildArgv(args, SETTINGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(64);
        expect(result.message).toContain("looks like a router key");
        expect(result.message).not.toContain(KEY);
        expect(result.message).not.toContain("FAKEKEY");
      }
    }
  });

  test("refuses by key shape: the prefix with 8+ key characters", () => {
    for (const shaped of [
      "mar_live_12345678",
      `x${KEY}suffix`,
      `--flag=mar_live_${"a".repeat(8)}`,
    ]) {
      expect(buildArgv([shaped], SETTINGS).ok).toBe(false);
    }
    expect(buildArgv(["--model", `mar_live_${"b".repeat(9)}`], SETTINGS).ok).toBe(false);
  });

  test("allows prompt text that merely mentions the prefix", () => {
    // The bare literal, or a too-short tail, is prose — not a key shape.
    for (const prose of [
      "explain the mar_live_ prefix",
      "mar_live_",
      "mar_live_ abc",
      "mar_live_abc",
      "mar_live_1234567",
    ]) {
      expect(buildArgv(["-p", prose], SETTINGS)).toEqual({
        ok: true,
        argv: ["--settings", SETTINGS, "-p", prose],
      });
    }
  });

  test("keeps prompt text that merely mentions --settings as a positional", () => {
    // A prompt string is a positional, not a flag: only exact flag tokens are
    // refused, so ordinary prompts survive untouched.
    expect(buildArgv(["-p", "run with --settings enabled"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "-p", "run with --settings enabled"],
    });
  });
});
