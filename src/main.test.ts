import { describe, expect, test } from "bun:test";
import { dispatch } from "./main";

describe("dispatch", () => {
  test("--version and -v request the version", () => {
    expect(dispatch(["--version"])).toEqual({ kind: "version" });
    expect(dispatch(["-v"])).toEqual({ kind: "version" });
  });

  test("reserved words are claimed only as the first argument", () => {
    for (const word of ["login", "doctor", "key"]) {
      expect(dispatch([word])).toEqual({ kind: "reserved", word });
    }
    expect(dispatch(["login", "--version"])).toEqual({ kind: "reserved", word: "login" });
    expect(dispatch(["keychain"])).toEqual({ kind: "passthrough", args: ["keychain"] });
    expect(dispatch(["--flag", "doctor"])).toEqual({
      kind: "passthrough",
      args: ["--flag", "doctor"],
    });
  });

  test("everything else is a passthrough", () => {
    expect(dispatch([])).toEqual({ kind: "passthrough", args: [] });
    expect(dispatch(["--verbose"])).toEqual({ kind: "passthrough", args: ["--verbose"] });
    expect(dispatch(["-p", "fix the bug"])).toEqual({
      kind: "passthrough",
      args: ["-p", "fix the bug"],
    });
  });
});
