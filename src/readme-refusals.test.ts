import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type DoctorDeps, runDoctor } from "./commands/doctor";
import { runKey } from "./commands/key";
import { MISSING_CONFIG_MESSAGE } from "./config/load";
import { cleanup, deadFetch, type Harness, harness, KEY } from "./launch/run-harness";
import type { FetchLike } from "./router/client";
import { type RefusalRow, readmeRefusalRows } from "./test-support/readme-table";

/**
 * The README's "Refusals and exit codes" table is the contract: each row
 * promises an exit code and, for most rows, the exact message claudes
 * prints. The scenarios below drive the real launcher (or helper) through
 * the run harness and produce the exit code and the text it actually
 * printed; the assertions then read the README's own table and check that
 * the produced behaviour is what the table promises.
 *
 * Nothing here transcribes a README message: the expected text comes from
 * the parsed table, so a doc-side edit fails this guard too. The rows are
 * selected by their "When" cell (stable prose, not the message), so a
 * changed message is a failed assertion rather than a silently re-targeted
 * row, and a row no scenario selects — added, reworded, or only a fragment
 * of a scenario's phrase — is an uncovered row, also a failure.
 */

/**
 * One thing a scenario observed: the exit code it produced and the text it
 * printed. `name` is the value the row's message template expects in place
 * of `<name>` — the env var a rerouting refusal names — and is undefined for
 * every other row. `spawned` is true when the scenario reached the spawn
 * seam; every refusal must fail before it.
 */
interface Observed {
  readonly code: number;
  readonly text: string;
  readonly name?: string;
  readonly spawned?: boolean;
}

interface Scenario {
  /** The row's "When" cell must contain this — how the row is identified. */
  readonly when: string;
  /** Runs the behaviour and returns what it produced. */
  readonly run: (h: Harness) => Promise<Observed[]> | Observed[];
}

/**
 * A router that answers the pre-launch check but reports no usable version:
 * the version carries the key body and a newline, which the client's version
 * shape refuses. The refusal must relay none of it.
 */
const unusableVersionFetch: FetchLike = async () =>
  new Response(JSON.stringify({ version: `${KEY}\n` }), { status: 200 });

/**
 * The scenarios, in the README's row order. Each one names the row it
 * covers by a phrase of its "When" cell — never by its message, which is
 * what the assertions are about. Every scenario gets its own harness, so
 * one scenario's setup (a deleted config, a planted variable) cannot
 * decide another's outcome.
 */
function scenarios(): Scenario[] {
  return [
    {
      when: "`--settings`",
      run: async (h) => [
        {
          code: await h.drive(["--settings", "/tmp/mine.json"], { fetch: deadFetch }),
          text: h.err.join(""),
          spawned: h.spawnCalls.length > 0,
        },
      ],
    },
    {
      when: "`--key`",
      run: async (h) => [
        {
          code: await h.drive(["--key", "x"], { fetch: deadFetch }),
          text: h.err.join(""),
          spawned: h.spawnCalls.length > 0,
        },
      ],
    },
    {
      when: "looks like a router key",
      run: async (h) => {
        // The row covers the argument in any position, before and after the
        // `--` terminator; each drive must produce the same refusal.
        const observed: Observed[] = [];
        for (const args of [
          ["-p", KEY],
          ["--", KEY],
        ]) {
          const code = await h.drive(args, { fetch: deadFetch });
          observed.push({
            code,
            text: h.err.join(""),
            // deadFetch would answer 69 were the probe reached: 64 proves
            // the refusal happened before it.
            spawned: h.spawnCalls.length > 0,
          });
          h.err.length = 0;
        }
        return observed;
      },
    },
    {
      // The row covers CLAUDE_CODE_HOST_AUTH_ENV_VAR, which carries the NAME
      // of the env var holding the host's credential: any non-empty value
      // counts, "0" and "false" included. The quoted message names the
      // variable, so each drive is checked against the row with its own name
      // in it.
      when: "any non-empty value",
      run: async (h) => {
        const observed: Observed[] = [];
        for (const value of ["0", "false", "ANTHROPIC_API_KEY"]) {
          const name = "CLAUDE_CODE_HOST_AUTH_ENV_VAR";
          const code = await h.drive(["-p", "hi"], {
            env: { HOME: h.home, PATH: h.binDir, [name]: value },
            fetch: deadFetch,
          });
          observed.push({
            code,
            text: h.err.join(""),
            name,
            spawned: h.spawnCalls.length > 0,
          });
          h.err.length = 0;
        }
        return observed;
      },
    },
    {
      // The row covers an unknown CLAUDE_CODE_USE_* toggle and
      // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: both are flags, so only a
      // truthy value is refused.
      when: "An unknown",
      run: async (h) => {
        const observed: Observed[] = [];
        for (const name of ["CLAUDE_CODE_USE_CCR_V2", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]) {
          const code = await h.drive(["-p", "hi"], {
            env: { HOME: h.home, PATH: h.binDir, [name]: "1" },
            fetch: deadFetch,
          });
          observed.push({
            code,
            text: h.err.join(""),
            name,
            spawned: h.spawnCalls.length > 0,
          });
          h.err.length = 0;
        }
        return observed;
      },
    },
    {
      when: "`BUN_CONFIG_VERBOSE_FETCH`",
      run: async (h) => [
        {
          code: await h.drive(["-p", "hi"], {
            env: { HOME: h.home, PATH: h.binDir, BUN_CONFIG_VERBOSE_FETCH: "1" },
            fetch: deadFetch,
          }),
          text: h.err.join(""),
          spawned: h.spawnCalls.length > 0,
        },
      ],
    },
    {
      when: "`claudes key` ran at a terminal",
      run: (h) => {
        const err: string[] = [];
        const writes: string[] = [];
        const code = runKey({
          env: { HOME: h.home },
          stdoutIsTTY: true,
          write: (text) => writes.push(text),
          stderr: (text) => err.push(text),
        });
        expect(writes).toEqual([]);
        return [{ code, text: err.join("") }];
      },
    },
    {
      when: "did not answer the pre-launch check",
      run: async (h) => [
        {
          code: await h.drive(["-p", "hi"], { fetch: deadFetch }),
          text: h.err.join(""),
          spawned: h.spawnCalls.length > 0,
        },
      ],
    },
    {
      // A router that answered the check but reported no usable version: a
      // different refusal from the router-down row, with the same exit code.
      when: "answered the pre-launch check without a usable version",
      run: async (h) => [
        {
          code: await h.drive(["-p", "hi"], { fetch: unusableVersionFetch }),
          text: h.err.join(""),
          spawned: h.spawnCalls.length > 0,
        },
      ],
    },
    {
      when: "No config",
      run: async (h) => {
        rmSync(h.home, { recursive: true, force: true });
        return [
          {
            code: await h.drive(["-p", "hi"]),
            text: h.err.join(""),
            spawned: h.spawnCalls.length > 0,
          },
        ];
      },
    },
    {
      when: "not on `PATH`",
      run: async (h) => [
        {
          code: await h.drive(["-p", "hi"], { env: { HOME: h.home, PATH: "/nonexistent" } }),
          text: h.err.join(""),
          spawned: h.spawnCalls.length > 0,
        },
      ],
    },
    {
      // The doctor row quotes no message: it promises the FAIL lines
      // themselves, so this scenario asserts the exit code and that the
      // FAIL lines were printed, and the row's prose cell carries no
      // message to compare.
      when: "had at least one FAIL",
      run: async () => {
        const out: string[] = [];
        const err: string[] = [];
        const deps: DoctorDeps = {
          env: { HOME: "/nonexistent-home" },
          platform: "linux",
          nodeVersion: "22.0.0",
          cwd: "/nonexistent-cwd",
          nodePath: "/nonexistent-node",
          scriptPath: "/nonexistent-claudes",
          fetch: async () => {
            throw new Error("readme test: doctor must not touch the network");
          },
          postFetch: async () => {
            throw new Error("readme test: doctor must not touch the network");
          },
          runProc: async () => {
            throw new Error("readme test: doctor must not spawn processes");
          },
          resolveExecutable: () => undefined,
          load: () => ({ ok: false, exitCode: 78, message: MISSING_CONFIG_MESSAGE }),
          readFile: () => undefined,
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
        };
        const code = await runDoctor([], deps);
        return [{ code, text: out.join("") }];
      },
    },
  ];
}

/**
 * The row the scenario covers: the one whose "When" cell contains the
 * scenario's phrase. Exactly one row must match, so an ambiguous phrase —
 * or a README that grew a second row with the same phrase — fails instead
 * of silently covering the wrong row.
 */
function rowFor(rows: RefusalRow[], when: string): RefusalRow {
  const matches = rows.filter((row) => row.when.includes(when));
  if (matches.length !== 1) {
    throw new Error(
      `README refusals table: ${matches.length} rows match "${when}", expected exactly 1`,
    );
  }
  const row = matches[0];
  if (row === undefined) {
    throw new Error(`README refusals table: no row matches "${when}"`);
  }
  return row;
}

/**
 * Every parsed row must be the row of exactly one scenario — the rule the
 * README's table and the scenarios below have to agree on.
 *
 * A scenario covers a row when the row's "When" prose contains the
 * scenario's phrase — the same relation `rowFor` reads from the other side.
 * A row that no scenario selects was never asserted against the behaviour,
 * and a row two scenarios select was asserted against twice: both are
 * failures. The check is per row, not a count of covered rows against a
 * count of parsed rows — a count says nothing about *which* rows are
 * covered, and a row whose prose is a strict substring of a scenario's
 * phrase ("a router key" against "looks like a router key") is selected by
 * no scenario while the counts still line up.
 */
function assertEveryRowCovered(rows: RefusalRow[], list: Scenario[]): void {
  const uncovered = rows.filter(
    (row) => list.filter((scenario) => row.when.includes(scenario.when)).length !== 1,
  );
  if (uncovered.length > 0) {
    const detail = uncovered.map((row) => `exit ${row.exit}, when "${row.when}"`).join("; ");
    throw new Error(
      `README refusals table: ${uncovered.length} of ${rows.length} rows are not the row of exactly one scenario: ${detail}`,
    );
  }
}

/**
 * The guard itself: every parsed row is the row of exactly one scenario,
 * and every scenario reproduces the exit code and the message its row
 * promises.
 */
async function assertRowsMatchScenarios(rows: RefusalRow[], list: Scenario[]): Promise<void> {
  // Coverage first: a row no scenario selects was never asserted against, so
  // the behaviour assertions below would not mean what they say.
  assertEveryRowCovered(rows, list);

  const covered = new Set<RefusalRow>();

  for (const scenario of list) {
    const row = rowFor(rows, scenario.when);
    expect(covered.has(row)).toBe(false);
    covered.add(row);

    // A harness per scenario: one scenario's setup (a deleted config, a
    // planted variable) cannot decide another's outcome, and the stderr
    // buffer below is this scenario's own output.
    const h = harness();
    let observed: Observed[];
    try {
      observed = await scenario.run(h);
    } finally {
      cleanup(h);
    }

    expect(observed.length).toBeGreaterThan(0);

    for (const one of observed) {
      expect(one.code).toBe(row.exit);

      // A refusal fails before the spawn seam: nothing runs.
      expect(one.spawned ?? false).toBe(false);

      if (row.message === undefined) {
        // A prose cell ("the FAIL lines themselves"): there is no quoted
        // message to compare, but the text must still be the promised one.
        expect(one.text).toContain("[FAIL]");
        continue;
      }

      expect(one.text).toBe(`${expectedMessage(row, one.name)}\n`);
    }
  }
}

/**
 * The row's message with its `<name>` template filled in — the one row that
 * names the variable the refusal names.
 */
function expectedMessage(row: RefusalRow, name: string | undefined): string {
  const message = row.message ?? "";
  return name === undefined ? message : message.replace("<name>", name);
}

describe("README refusals and exit codes table", () => {
  test("every documented row is asserted against the live behaviour", async () => {
    await assertRowsMatchScenarios(readmeRefusalRows(), scenarios());
  });

  test("no row is covered twice", () => {
    const rows = readmeRefusalRows();
    const phrases = scenarios().map((scenario) => scenario.when);
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const phrase of phrases) {
      expect(rows.filter((row) => row.when.includes(phrase)).length).toBe(1);
    }
  });

  test("the two env rows gate on different values", async () => {
    // The two env rows differ in what they accept, and the difference is
    // only visible from the side that is NOT refused.
    //
    // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is a flag: unset, empty, "0" and
    // "false" all fall through to the router probe (69 with the dead fetch),
    // never to the exit-64 refusal.
    for (const value of ["", "0", "false"]) {
      const h = harness();
      try {
        const code = await h.drive(["-p", "hi"], {
          env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: value },
          fetch: deadFetch,
        });
        expect(code).toBe(69);
        expect(h.err.join("")).not.toContain("would not go to the router");
      } finally {
        cleanup(h);
      }
    }

    // CLAUDE_CODE_HOST_AUTH_ENV_VAR carries the NAME of the env var holding
    // the host's credential: only an empty value is left alone, while "0"
    // and "false" are refused — they are names, not flags.
    for (const [value, refused] of [
      ["", false],
      ["0", true],
      ["false", true],
    ] as const) {
      const h = harness();
      try {
        const code = await h.drive(["-p", "hi"], {
          env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_HOST_AUTH_ENV_VAR: value },
          fetch: deadFetch,
        });
        expect(code).toBe(refused ? 64 : 69);
        expect(h.err.join("").includes("would not go to the router")).toBe(refused);
      } finally {
        cleanup(h);
      }
    }
  });

  test("a row whose phrase is a fragment of a scenario's phrase is never covered", async () => {
    // The shape of the hole a count-based coverage check cannot see: every
    // scenario still selects exactly one row, and one more row is added
    // whose "When" prose is a strict substring of a scenario's phrase -
    // "a router key" inside "looks like a router key" - so no scenario
    // selects it and nothing is ever asserted against it.
    const list = scenarios();
    const readme = readmeRefusalRows();

    // One row per scenario, each carrying its scenario's phrase and the
    // message the README promises for it, plus the fragment row that no
    // scenario selects.
    const rows: RefusalRow[] = list.map((scenario) => {
      const row = readme.find((candidate) => candidate.when.includes(scenario.when));
      if (row === undefined) {
        throw new Error(`README refusals table: no row covers ${scenario.when}`);
      }
      return { ...row, when: `A refusal covered by ${scenario.when}` };
    });
    const fragment: RefusalRow = { exit: 64, when: "a router key", message: "claudes: refused" };

    // Every scenario still selects exactly one row, so nothing about the
    // selection itself looks wrong: the fragment row is simply never
    // selected.
    for (const scenario of list) {
      expect(rows.filter((row) => row.when.includes(scenario.when)).length).toBe(1);
    }

    // The guard rejects the table and names the row no scenario ever
    // asserted against.
    await expect(assertRowsMatchScenarios(rows.concat(fragment), list)).rejects.toThrow(
      /1 of 13 rows are not the row of exactly one scenario: exit 64, when "a router key"/,
    );
  });
});
