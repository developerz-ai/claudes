import { describe, expect, test } from "bun:test";
import { USAGE as DOCTOR_USAGE } from "./commands/doctor";
import { USAGE as LOGIN_USAGE } from "./commands/login-args";
import { HELP_SCOPES, type HelpScope } from "./dispatch";
import { HELP_FLAGS, HELP_SCOPE_FLAGS, HELP_TEXTS, helpText } from "./help";
import { KEY } from "./test-support/fixtures";
import { assertNoKeyFragment } from "./test-support/redact";

/**
 * claudes' own help output, guarded without reading the README: the README
 * contract test (src/readme.test.ts) binds the README to these texts, so the
 * texts need a contract of their own — every flag they name is the flag of
 * their scope, no usage string is typed twice, and no text carries a key or a
 * deployment hostname.
 */

/**
 * The flags each help output must name, pinned here so a scope that loses a
 * flag fails even when the scope's own inventory shrinks with it.
 */
const EXPECTED_SCOPE_FLAGS: Readonly<Record<HelpScope, readonly string[]>> = {
  top: ["--version", "-v", "--help", "--model", "-p"],
  login: ["--url", "--opus", "--sonnet", "--haiku"],
  doctor: ["--live"],
};

/**
 * Every flag token a text names, long or short, deduped. A token counts as a
 * flag only after whitespace, a quote, a backtick, a bracket or a line start,
 * so hyphenated prose ("command-line", "apiKeyHelper") is not mistaken for a
 * flag.
 */
function flagsIn(text: string): Set<string> {
  return new Set(text.match(/(?<=[\s`"([]|^)--?[A-Za-z][A-Za-z0-9-]*/gm) ?? []);
}

/**
 * A dotted name that could be a hostname. The help texts name no deployment:
 * a router hostname belongs in the config, not in every terminal that asks
 * for help.
 */
const HOSTNAME = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/i;

describe("help output", () => {
  test("every scope has a text, and the scopes are the ones dispatch routes to", () => {
    expect([...Object.keys(HELP_TEXTS)].sort()).toEqual([...HELP_SCOPES].sort());
    for (const scope of HELP_SCOPES) {
      expect(helpText(scope)).toBe(HELP_TEXTS[scope]);
    }
  });

  for (const scope of HELP_SCOPES) {
    test(`the ${scope} help names exactly its own flags`, () => {
      const expected: string[] = [...EXPECTED_SCOPE_FLAGS[scope]].sort();
      // The text names them...
      const named: string[] = [...flagsIn(HELP_TEXTS[scope])].sort();
      expect(named).toEqual(expected);
      // ...and the scope's inventory is the same list, so the README contract
      // test (which reads the inventory) cannot drift from the text.
      const inventory: string[] = [...HELP_SCOPE_FLAGS[scope]].sort();
      expect(inventory).toEqual(expected);
    });
  }

  test("the top-level inventory is the flags the top-level help names", () => {
    const expected: string[] = [...EXPECTED_SCOPE_FLAGS.top].sort();
    const inventory: string[] = [...HELP_FLAGS].sort();
    expect(inventory).toEqual(expected);
  });

  test("the command help reuses the commands' own usage strings", () => {
    // The usage text lives in the command that refuses with it; the help
    // output only quotes it, so the two can never say different things.
    expect(HELP_TEXTS.login.startsWith(LOGIN_USAGE)).toBe(true);
    expect(HELP_TEXTS.doctor.startsWith(DOCTOR_USAGE)).toBe(true);
  });

  test("no help output carries router-key material", () => {
    for (const scope of HELP_SCOPES) {
      const text = HELP_TEXTS[scope];
      assertNoKeyFragment(text, KEY);
      expect(text).not.toContain("mar_live_");
    }
  });

  test("no help output names a deployment hostname", () => {
    for (const scope of HELP_SCOPES) {
      const text = HELP_TEXTS[scope];
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(HOSTNAME);
    }
  });

  test("no help output ends with a newline of its own", () => {
    // The printer adds the final newline; a text that carried one would print
    // a blank line after it.
    for (const scope of HELP_SCOPES) {
      expect(HELP_TEXTS[scope].endsWith("\n")).toBe(false);
    }
  });
});
