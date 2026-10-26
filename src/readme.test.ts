import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type DoctorDeps, runDoctor } from "./commands/doctor";
import { parseLoginArgs } from "./commands/login-args";
import { MISSING_CONFIG_MESSAGE } from "./config/load";
import { dispatch } from "./dispatch";
import { buildArgv } from "./launch/argv";
import * as preflight from "./launch/preflight";
import { UNSUPPORTED_FEATURES, type UnsupportedFeature } from "./launch/unsupported";
import {
  type RefusalRow,
  readmeKnownGapRows,
  readmeNetworkNotes,
  readmeRefusalRows,
} from "./test-support/readme-table";

/**
 * claudes has no --help output of its own: dispatch() routes the first
 * argument (login / doctor / key / --version) and passes everything else
 * through to claude. The assertions below therefore run against the parsers
 * themselves — dispatch(), parseLoginArgs() and runDoctor()'s argument loop —
 * which are the source of truth for what this CLI accepts.
 */

const LOGIN_URL = "https://router.invalid";

/**
 * Flags that are Claude Code's own, not claudes': claudes rewrites their
 * values (--model) or passes them through untouched (-p). They are claude's
 * to define, so they are allowlisted here and asserted against nothing.
 */
const CLAUDE_FLAGS: ReadonlySet<string> = new Set(["--model", "-p"]);

/**
 * Flags claudes refuses outright. The exit code and the message come from
 * the README's own "Refusals and exit codes" table (parsed by
 * src/test-support/readme-table.ts), so a doc-side edit fails the refusal
 * test below too. The refusal is claudes' own behaviour, so these flags are
 * NOT allowlisted above: a change that made claudes accept them would fail
 * the refusal test below.
 */
const REFUSED_FLAGS: ReadonlySet<string> = new Set(["--settings", "--key"]);

/**
 * The README row that documents the refusal of `flag`: the one whose "When"
 * cell names the flag in a code span. Exactly one row must match, and it
 * must quote a message — a refusal row without one documents nothing.
 */
function refusalRowFor(flag: string): RefusalRow & { readonly message: string } {
  const rows = readmeRefusalRows().filter((row) => row.when.includes(`\`${flag}\``));
  if (rows.length !== 1) {
    throw new Error(
      `README refusals table: ${rows.length} rows document ${flag}, expected exactly 1`,
    );
  }
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`README refusals table: no row documents ${flag}`);
  }
  if (row.message === undefined) {
    throw new Error(`README refusals table: the ${flag} row quotes no message`);
  }
  return { ...row, message: row.message };
}

/**
 * Flags of the other commands in the README's shell snippets: npm's `-g` and
 * rm's `-rf` in the install/uninstall commands. Neither claudes' nor
 * claude's, so they are asserted against nothing.
 */
const SHELL_FLAGS: ReadonlySet<string> = new Set(["-g", "-rf"]);

/**
 * Every flag token the README mentions, long or short, deduped. A token
 * counts as a flag only after whitespace, a quote, a backtick, a bracket or
 * a line start, so hyphenated prose ("known-benign", "claude-opus-5-5") and
 * the bare `--` terminator are not mistaken for flags.
 */
function readmeFlags(): Set<string> {
  const path = fileURLToPath(new URL("../README.md", import.meta.url));
  const readme = readFileSync(path, "utf8");
  return new Set(readme.match(/(?<=[\s`"([]|^)--?[A-Za-z][A-Za-z0-9-]*/gm) ?? []);
}

/**
 * runDoctor dependencies for a machine with no claude and no config: every
 * check fails fast on injected fakes, so no process is spawned, no file is
 * read and no network is touched. Enough to observe how runDoctor parsed its
 * argv.
 */
function noConfigDoctorDeps(): { deps: DoctorDeps; out: string[]; err: string[] } {
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
  return { deps, out, err };
}

/**
 * The flags claudes owns, each mapped to the assertion that its own parser
 * accepts it. A README flag that is in none of CLAUDES_FLAG_CHECKS,
 * CLAUDE_FLAGS, REFUSED_FLAGS or SHELL_FLAGS fails the first test below, so
 * this table cannot silently fall behind the docs.
 */
const CLAUDES_FLAG_CHECKS: Readonly<Record<string, () => Promise<void>>> = {
  "--version": async () => {
    expect(dispatch(["--version"]).kind).toBe("version");
    expect(dispatch(["-v"]).kind).toBe("version");
  },
  "-v": async () => {
    expect(dispatch(["-v"]).kind).toBe("version");
  },
  "--url": async () => {
    expect(parseLoginArgs(["--url", LOGIN_URL]).ok).toBe(true);
  },
  "--opus": async () => {
    expect(parseLoginArgs(["--url", LOGIN_URL, "--opus", "claude-opus-5-5"]).ok).toBe(true);
  },
  "--sonnet": async () => {
    expect(parseLoginArgs(["--url", LOGIN_URL, "--sonnet", "claude-sonnet-5-5"]).ok).toBe(true);
  },
  "--haiku": async () => {
    expect(parseLoginArgs(["--url", LOGIN_URL, "--haiku", "claude-haiku-4-5"]).ok).toBe(true);
  },
  "--live": async () => {
    const { deps, out, err } = noConfigDoctorDeps();
    const code = await runDoctor(["--live"], deps);
    // The fakes make the checks FAIL (exit 1); what proves --live was parsed
    // is the absence of the usage error and the live-check INFO line, which
    // runDoctor prints only when --live was accepted.
    expect(err.join("")).not.toContain("unknown argument");
    expect(code).toBe(1);
    expect(out.join("")).toContain("live request skipped");
  },
};

describe("README flags", () => {
  test("every flag the README mentions is owned by claudes or by claude", () => {
    const flags = readmeFlags();
    expect(flags.size).toBeGreaterThan(0); // the extraction itself still works
    const unknown = [...flags]
      .filter(
        (flag) =>
          !CLAUDE_FLAGS.has(flag) &&
          !(flag in CLAUDES_FLAG_CHECKS) &&
          !REFUSED_FLAGS.has(flag) &&
          !SHELL_FLAGS.has(flag),
      )
      .sort();
    expect(unknown).toEqual([]);
  });

  test("claudes' own parsers accept every flag it owns", async () => {
    for (const [flag, check] of Object.entries(CLAUDES_FLAG_CHECKS)) {
      try {
        await check();
      } catch (err) {
        throw new Error(`README flag ${flag} was rejected by its parser: ${String(err)}`, {
          cause: err,
        });
      }
    }
  });

  test("claudes refuses --settings and --key with exit 64 and the README's message", () => {
    for (const flag of REFUSED_FLAGS) {
      const row = refusalRowFor(flag);
      // The README's row is the source of truth for the exit code too; the
      // refusal is a usage error, so the README must say 64.
      expect(row.exit).toBe(64);
      // Both spellings hit the same refusal: the separated value and
      // `--flag=value`. run() turns this ArgvResult into the process's exit
      // code and stderr line — covered end to end in readme-refusals.test.ts.
      for (const args of [[flag, "x"], [`${flag}=x`]]) {
        expect(buildArgv(args, "/tmp/settings.json")).toEqual({
          ok: false,
          exitCode: 64,
          message: row.message,
        });
      }
    }
  });

  test("the parsers still refuse flags nobody documents", async () => {
    // dispatch passes anything unknown through to claude — claudes itself
    // only recognises the reserved words and --version.
    expect(dispatch(["--bogus"]).kind).toBe("passthrough");
    expect(parseLoginArgs(["--url", LOGIN_URL, "--bogus"]).ok).toBe(false);
    const { deps, err } = noConfigDoctorDeps();
    expect(await runDoctor(["--bogus"], deps)).toBe(64);
    expect(err.join("")).toContain("unknown argument");
  });
});

const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function assertDisabledGaps(source: string, features = UNSUPPORTED_FEATURES): void {
  const documented = readmeKnownGapRows(source)
    .filter((row) => /^Disabled\b/.test(row.status))
    .map((row) => {
      const feature = row.what === "Advisor tool" ? "advisor" : row.what;
      const status = row.status.match(/^Disabled \(`([^`]+)` in the generated settings\): .+$/);
      const issue = row.issue.match(/^\[#[0-9]+\]\((https:\/\/github\.com\/[^)]+)\)$/);
      if (status === null || issue === null) {
        throw new Error(`README disabled gap has malformed mechanism or issue: ${row.what}`);
      }
      const mechanism = status[1] ?? "";
      const env = mechanism.match(/^([A-Z_][A-Z0-9_]*)=([^=]+)$/);
      if (mechanism !== "permissions.deny" && env === null) {
        throw new Error(`README disabled gap has unknown mechanism: ${row.what}`);
      }
      // permissions.deny disables the tool named by the row; env rows quote NAME=value.
      const removedBy =
        mechanism === "permissions.deny"
          ? { kind: "deny", rule: feature }
          : { kind: "env", name: env?.[1], value: env?.[2] };
      return JSON.stringify({ feature, removedBy, issue: issue[1] });
    })
    .sort();
  const expected = features
    .map((feature) => {
      const issue = feature.issue.match(/^([^#]+)#([0-9]+)$/);
      if (issue === null) {
        throw new Error(`Unsupported feature has malformed issue: ${feature.issue}`);
      }
      return JSON.stringify({
        feature: feature.feature,
        removedBy: feature.removedBy,
        issue: `https://github.com/${issue[1]}/issues/${issue[2]}`,
      });
    })
    .sort();
  expect(documented).toEqual(expected);
}

function assertNetworkNotes(
  source: string,
  exports: Readonly<Record<string, unknown>> = preflight,
) {
  const messages = Object.entries(exports)
    .filter(([name]) => name.endsWith("_NOTE_MESSAGE"))
    .map(([name, value]) => {
      if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
      }
      return value;
    });
  expect(messages.length).toBeGreaterThan(0);
  // Compare sorted arrays, not sets: multiplicity is part of the contract.
  expect(readmeNetworkNotes(source).sort()).toEqual(messages.sort());
}

describe("README disabled-feature guard", () => {
  test("Disabled rows match production bijectively, leaving informational gaps alone", () => {
    assertDisabledGaps(readmeSource);
  });

  const disabledRows = readmeSource.split("\n").filter((line) => line.includes("| Disabled ("));
  for (const row of disabledRows) {
    for (const [label, replacement] of Object.entries({
      removed: "",
      duplicated: `${row}\n${row}`,
      added: `${row}\n${row.replace(/^\| [^|]+ \|/, "| New feature |")}`,
      "changed feature": row.replace(/^\| [^|]+ \|/, "| Renamed feature |"),
      "changed mechanism": row.replace(/`[^`]+`/, "`WRONG_SWITCH=1`"),
      "changed issue URL": row.replace(/issues\/\d+/, "issues/999"),
      "no longer Disabled": row.replace("Disabled", "Informational"),
    })) {
      test(`rejects ${label}: ${row.split("|")[1]?.trim()}`, () => {
        const source =
          label === "removed"
            ? readmeSource.replace(`${row}\n`, "")
            : readmeSource.replace(row, replacement);
        expect(() => assertDisabledGaps(source)).toThrow();
      });
    }
  }

  test("also catches production additions and removals", () => {
    const extra: UnsupportedFeature = {
      feature: "New feature",
      reason: "fixture",
      removedBy: { kind: "deny", rule: "New feature" },
      issue: "developerz-ai/multi-ai-router#999",
    };
    expect(() => assertDisabledGaps(readmeSource, [...UNSUPPORTED_FEATURES, extra])).toThrow();
    expect(() => assertDisabledGaps(readmeSource, UNSUPPORTED_FEATURES.slice(1))).toThrow();
  });
});

describe("README network-note guard", () => {
  test("quotes every exported preflight *_NOTE_MESSAGE exactly once", () => {
    assertNetworkNotes(readmeSource);
  });

  for (const note of readmeNetworkNotes(readmeSource)) {
    for (const [label, replacement] of Object.entries({
      changed: `${note} changed`,
      removed: "",
      duplicated: `${note}\n${note}`,
      added: `${note}\nnote: unexpected additional hint`,
    })) {
      test(`rejects ${label} note: ${note}`, () => {
        const mutated = readmeSource.replace(note, replacement);
        // Remove the whole line, rather than turning it into a malformed blank note.
        const source = label === "removed" ? readmeSource.replace(`${note}\n`, "") : mutated;
        expect(() => assertNetworkNotes(source)).toThrow();
      });
    }
  }

  test("discovers new exports rather than using a fixed note list", () => {
    expect(() =>
      assertNetworkNotes(readmeSource, {
        ...preflight,
        FUTURE_NOTE_MESSAGE: "note: newly exported hint",
      }),
    ).toThrow();
  });
});
