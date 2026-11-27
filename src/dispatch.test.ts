import { describe, expect, test } from "bun:test";
import {
  dispatch,
  INVALID_PROFILE_MESSAGE,
  MISPLACED_PROFILE_MESSAGE,
  REPEATED_PROFILE_MESSAGE,
} from "./dispatch";

describe("dispatch", () => {
  test("--version and -v request the version", () => {
    expect(dispatch(["--version"])).toEqual({ kind: "version" });
    expect(dispatch(["-v"])).toEqual({ kind: "version" });
  });

  test("reserved words are claimed only as the first argument", () => {
    for (const word of ["login", "doctor", "key"] as const) {
      expect(dispatch([word])).toEqual({ kind: "reserved", word });
    }
    expect(dispatch(["login", "--version"])).toEqual({ kind: "reserved", word: "login" });
    expect(dispatch(["keychain"])).toEqual({ kind: "passthrough", args: ["keychain"] });
    expect(dispatch(["--flag", "doctor"])).toEqual({
      kind: "passthrough",
      args: ["--flag", "doctor"],
    });
  });

  test("--help asks for the top-level help", () => {
    expect(dispatch(["--help"])).toEqual({ kind: "help", scope: "top" });
  });

  test("login --help and doctor --help ask for the command's own help", () => {
    expect(dispatch(["login", "--help"])).toEqual({ kind: "help", scope: "login" });
    expect(dispatch(["doctor", "--help"])).toEqual({ kind: "help", scope: "doctor" });
  });

  test("key --help still reaches the key command, which refuses every argument", () => {
    // The key command takes no arguments at all, so `claudes key --help` is
    // not a help request: it must reach the command and be refused there.
    expect(dispatch(["key", "--help"])).toEqual({ kind: "reserved", word: "key" });
  });

  test("a help flag beside other arguments keeps the command's own handling", () => {
    // Only a lone --help asks for help. Anything else keeps the refusal the
    // command owns — the router-key refusal above all.
    expect(dispatch(["login", "--help", "--url", "https://router.invalid"])).toEqual({
      kind: "reserved",
      word: "login",
    });
    expect(dispatch(["doctor", "--live", "--help"])).toEqual({
      kind: "reserved",
      word: "doctor",
    });
  });

  test("everything else is a passthrough", () => {
    expect(dispatch([])).toEqual({ kind: "passthrough", args: [] });
    expect(dispatch(["--verbose"])).toEqual({ kind: "passthrough", args: ["--verbose"] });
    expect(dispatch(["--help", "extra"])).toEqual({
      kind: "passthrough",
      args: ["--help", "extra"],
    });
    expect(dispatch(["-p", "fix the bug"])).toEqual({
      kind: "passthrough",
      args: ["-p", "fix the bug"],
    });
  });

  test("a leading --profile selects the session's profile for the passthrough", () => {
    expect(dispatch(["--profile", "work"])).toEqual({
      kind: "passthrough",
      args: [],
      profile: "work",
    });
    expect(dispatch(["--profile=work", "-p", "hi"])).toEqual({
      kind: "passthrough",
      args: ["-p", "hi"],
      profile: "work",
    });
    // A manage command keeps its own handling; the profile is simply unused.
    expect(dispatch(["--profile", "work", "mcp"])).toEqual({
      kind: "passthrough",
      args: ["mcp"],
      profile: "work",
    });
  });

  test("an invalid leading --profile name is a usage error that never echoes it", () => {
    for (const argv of [["--profile"], ["--profile="], ["--profile", "Bad"], ["--profile", "-p"]]) {
      expect(dispatch(argv)).toEqual({ kind: "usage", message: INVALID_PROFILE_MESSAGE });
    }
  });

  test("a leading --profile before a claudes command is refused, never launched", () => {
    // Without this, `claudes --profile work doctor` started a routed session
    // with "doctor" as the prompt, spending router quota.
    for (const rest of [
      ["login"],
      ["doctor"],
      ["key"],
      ["profile", "list"],
      ["--help"],
      ["--version"],
      ["-v"],
      ["doctor", "--help"],
    ]) {
      expect(dispatch(["--profile", "work", ...rest])).toEqual({
        kind: "usage",
        message: MISPLACED_PROFILE_MESSAGE,
      });
    }
  });

  test("a second leading --profile is refused", () => {
    expect(dispatch(["--profile", "a", "--profile", "b"])).toEqual({
      kind: "usage",
      message: REPEATED_PROFILE_MESSAGE,
    });
  });
});
