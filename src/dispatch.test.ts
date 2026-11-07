import { describe, expect, test } from "bun:test";
import { dispatch } from "./dispatch";

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
});
