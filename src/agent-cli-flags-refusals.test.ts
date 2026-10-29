import { describe, expect, test } from "bun:test";
import { type ArgsResult, parseLoginArgs } from "./commands/login-args";
import { cliFlagsRefusalExamples } from "./test-support/agent-cli-flags";
import { KEY, ROUTER } from "./test-support/fixtures";
import { assertNoKeyFragment } from "./test-support/redact";

/**
 * The refusal examples cli-flags.md quotes are the contract: each one must
 * be the lede of the usage refusal the live parseLoginArgs produces for the
 * argv that triggers it. Nothing here transcribes a message: the expected
 * text is parsed from .claude/agents/cli-flags.md at run time, so a doc-side
 * wording edit fails this guard, and the refusal is produced live, so a
 * parser-side wording edit fails it too.
 *
 * Every extracted example is selected by exactly one scenario — keyed on a
 * stable substring of the example, never the whole message — and every
 * scenario's substring must exist in the doc, so a dropped or added quote
 * fails loudly instead of silently going uncovered.
 */

/** Sentinels the refusal must never echo. */
const OTHER_ROUTER = "https://other.example.test";
const BOGUS_TIER = "not a model id!";
const BOGUS_FLAG = "--not-a-real-flag";

interface Scenario {
  /** The stable substring of the doc example this scenario reproduces. */
  readonly phrase: string;
  /** The argv that makes parseLoginArgs refuse with that example's lede. */
  readonly argv: readonly string[];
  /** Values that must never appear in the refusal message. */
  readonly sensitive: readonly string[];
}

/**
 * The scenarios. Each argv produces the refusal its phrase names: a
 * duplicated --url, a tier slot holding a value that is no model id, and a
 * bogus flag after four valid tokens so the refusal lands on position 5.
 */
function scenarios(): Scenario[] {
  return [
    {
      phrase: "may only be given once",
      argv: ["--url", ROUTER, "--url", OTHER_ROUTER],
      sensitive: [ROUTER, OTHER_ROUTER],
    },
    {
      phrase: "is not a valid model id",
      argv: ["--url", ROUTER, "--opus", BOGUS_TIER],
      sensitive: [BOGUS_TIER],
    },
    {
      phrase: "unknown option #",
      argv: ["--url", ROUTER, "--opus", "claude-opus-4-1", BOGUS_FLAG],
      sensitive: [BOGUS_FLAG],
    },
  ];
}

/**
 * The doc example the scenario covers: the one containing the scenario's
 * phrase. Exactly one example must match, so an ambiguous phrase — or a doc
 * that grew a second quote with the same phrase — fails instead of silently
 * covering the wrong example.
 */
function exampleFor(examples: string[], phrase: string): string {
  const matches = examples.filter((example) => example.includes(phrase));
  if (matches.length !== 1) {
    throw new Error(
      `cli-flags.md refusal examples: ${matches.length} examples contain "${phrase}", expected exactly 1`,
    );
  }
  const example = matches[0];
  if (example === undefined) {
    throw new Error(`cli-flags.md refusal examples: no example contains "${phrase}"`);
  }
  return example;
}

describe("cli-flags.md refusal examples", () => {
  test("every quoted example is asserted against the live parseLoginArgs refusal", () => {
    const examples = cliFlagsRefusalExamples();
    const list = scenarios();

    // Coverage first: an example no scenario selects was never asserted
    // against, and one two scenarios select was asserted against twice —
    // both failures, so a dropped or added quote fails loudly.
    const uncovered = examples.filter(
      (example) => list.filter((scenario) => example.includes(scenario.phrase)).length !== 1,
    );
    expect(uncovered).toEqual([]);

    const covered = new Set<string>();
    for (const scenario of list) {
      const example = exampleFor(examples, scenario.phrase);
      expect(covered.has(example)).toBe(false);
      covered.add(example);

      const result: ArgsResult = parseLoginArgs(scenario.argv);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("unreachable: ok was checked above");
      }
      expect(result.exitCode).toBe(64);

      // The usage refusal is the lede, then a blank line, then USAGE (joined
      // by "\n\n", per login-args.ts). The quoted example must appear verbatim
      // in the lede — a whole lede when the doc carries the "claudes login: "
      // prefix, its tail when it does not — and never in USAGE alone.
      const lede = result.message.split("\n\n")[0] ?? "";
      expect(lede.includes(example)).toBe(true);

      // No refusal echoes an argv value: no window of the key body, and none
      // of the sentinel values that triggered the refusal.
      assertNoKeyFragment(result.message, KEY);
      for (const value of scenario.sensitive) {
        expect(result.message.includes(value)).toBe(false);
      }
    }
  });

  test("the doc lists at least the three quoted refusal examples", () => {
    // A re-shaped bullet — anchor reworded, parenthesised list dropped or
    // emptied — throws inside the reader instead of passing here.
    expect(cliFlagsRefusalExamples().length).toBeGreaterThanOrEqual(3);
  });

  test("no scenario's argv carries a router key", () => {
    // A key-shaped token would be refused by the prefix scan before reaching
    // any of these refusals, making the scenario assert the wrong behaviour.
    for (const scenario of scenarios()) {
      expect(scenario.argv.some((token) => token.includes(KEY))).toBe(false);
    }
  });
});
