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

  test("keeps prompt text that merely mentions --settings as a positional", () => {
    // A prompt string is a positional, not a flag: only exact flag tokens are
    // refused, so ordinary prompts survive untouched.
    expect(buildArgv(["-p", "run with --settings enabled"], SETTINGS)).toEqual({
      ok: true,
      argv: ["--settings", SETTINGS, "-p", "run with --settings enabled"],
    });
  });
});
