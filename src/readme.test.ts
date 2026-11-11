import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOCTOR_FLAGS, type DoctorDeps, runDoctor } from "./commands/doctor";
import { LOGIN_FLAGS, parseLoginArgs } from "./commands/login-args";
import { MISSING_CONFIG_MESSAGE } from "./config/load";
import { dispatch, HELP_SCOPES, type HelpScope, VERSION_FLAGS } from "./dispatch";
import { HELP_FLAGS, HELP_SCOPE_FLAGS, HELP_TEXTS } from "./help";
import { buildArgv } from "./launch/argv";
import * as preflight from "./launch/preflight";
import { UNSUPPORTED_FEATURES, type UnsupportedFeature } from "./launch/unsupported";
import { KEY } from "./test-support/fixtures";
import {
  type RefusalRow,
  readmeKnownGapRows,
  readmeNetworkNotes,
  readmeRefusalRows,
} from "./test-support/readme-table";
import { assertNoKeyFragment } from "./test-support/redact";

/**
 * The README and the CLI are one contract: dispatch() routes the first
 * argument (login / doctor / key / --version / --help) and passes everything
 * else through to claude, so the assertions below run against the parsers and
 * the help output themselves — dispatch(), parseLoginArgs(), runDoctor()'s
 * argument loop and the texts in src/help.ts — which are the source of truth
 * for what this CLI accepts.
 */

const LOGIN_URL = "https://router.invalid";
const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const brainSource = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
/**
 * claudes' own flags: the ones the CLI claims, the ones the top-level help
 * names, and the ones the commands own. The help inventory is part of it: the
 * top-level help documents --help, --model and -p, so they are claudes' own
 * spellings and the README has to document them.
 */
const OWNED_FLAGS: readonly string[] = [
  ...new Set([...VERSION_FLAGS, ...HELP_FLAGS, ...LOGIN_FLAGS, ...DOCTOR_FLAGS]),
];

/** Undocumented owned spellings require a reason; remove exceptions once documented. */
const UNDOCUMENTED_FLAGS: Readonly<Record<string, string>> = {};

/**
 * Flags that are Claude Code's own, not claudes': claudes rewrites their
 * values (--model) or passes them through untouched (-p). They are claude's
 * to define, so they are allowlisted here; claudes' help output names them
 * too, so they also carry a parser check — the rewrite and the pass-through
 * are claudes' own behaviour.
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
 * rm's `-rf` in the install/uninstall commands, and shasum's `-a` in the
 * uninstall drill's checksum command. Neither claudes' nor claude's, so they
 * are asserted against nothing.
 */
const SHELL_FLAGS: ReadonlySet<string> = new Set(["-g", "-rf", "-a"]);

/**
 * Every flag token a text mentions, long or short, deduped. A token counts
 * as a flag only after whitespace, a quote, a backtick, a bracket or a line
 * start, so hyphenated prose ("known-benign", "claude-opus-5-5") and the bare
 * `--` terminator are not mistaken for flags. The README and the help outputs
 * are read the same way, so one reader serves both.
 */
function flagsIn(source: string): Set<string> {
  return new Set(source.match(/(?<=[\s`"([]|^)--?[A-Za-z][A-Za-z0-9-]*/gm) ?? []);
}

/** Refusal examples are not positive documentation of accepted options. */
function positiveReadmeFlags(source: string): Set<string> {
  return flagsIn(source.replace(/^## Refusals and exit codes\r?\n.*?(?=^## |$(?![\s\S]))/gms, ""));
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
 * accepts it. The inventories drive ownership; the completeness guard below
 * requires both a parser assertion and positive documentation for every spelling.
 */
const CLAUDES_FLAG_CHECKS: Readonly<Record<string, () => Promise<void>>> = {
  "--version": async () => {
    expect(dispatch(["--version"]).kind).toBe("version");
    expect(dispatch(["-v"]).kind).toBe("version");
  },
  "-v": async () => {
    expect(dispatch(["-v"]).kind).toBe("version");
  },
  "--help": async () => {
    expect(dispatch(["--help"]).kind).toBe("help");
  },
  "--model": async () => {
    // claudes owns the rewrite: Claude Code's alias becomes the bare tier
    // name the router serves.
    expect(buildArgv(["--model", "claude-opus"], "/tmp/settings.json")).toEqual({
      ok: true,
      argv: ["--settings", "/tmp/settings.json", "--model", "opus"],
    });
  },
  "-p": async () => {
    // Passed through untouched: the prompt is claude's to read.
    expect(buildArgv(["-p", "hi"], "/tmp/settings.json")).toEqual({
      ok: true,
      argv: ["--settings", "/tmp/settings.json", "-p", "hi"],
    });
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

function assertOwnedFlagCoverage(
  source: string,
  owned: readonly string[] = OWNED_FLAGS,
  checks: Readonly<Record<string, () => Promise<void>>> = CLAUDES_FLAG_CHECKS,
  exceptions: Readonly<Record<string, string>> = UNDOCUMENTED_FLAGS,
): void {
  const documented = positiveReadmeFlags(source);
  const problems: string[] = [];
  for (const flag of owned) {
    if (!Object.hasOwn(checks, flag)) problems.push(`${flag}: missing parser check`);
    if (!documented.has(flag) && !Object.hasOwn(exceptions, flag)) {
      problems.push(`${flag}: missing README documentation`);
    }
  }
  for (const flag of Object.keys(checks)) {
    if (!owned.includes(flag)) problems.push(`${flag}: parser check is not owned`);
  }
  for (const [flag, reason] of Object.entries(exceptions)) {
    if (!owned.includes(flag) || documented.has(flag)) {
      problems.push(`${flag}: stale undocumented exception`);
    }
    if (reason.trim() === "") problems.push(`${flag}: undocumented exception needs a reason`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

describe("README flags", () => {
  test("every parser-owned spelling has a parser check and positive documentation", () => {
    assertOwnedFlagCoverage(readmeSource);
  });

  for (const flag of ["--opus", "-v"]) {
    test(`rejects omitted documentation for ${flag}`, () => {
      const source = readmeSource.replaceAll(flag, "omitted");
      expect(() => assertOwnedFlagCoverage(source)).toThrow(
        `${flag}: missing README documentation`,
      );
    });

    test(`rejects missing parser check for ${flag}`, () => {
      const checks = Object.fromEntries(
        Object.entries(CLAUDES_FLAG_CHECKS).filter(([name]) => name !== flag),
      );
      expect(() => assertOwnedFlagCoverage(readmeSource, OWNED_FLAGS, checks)).toThrow(
        `${flag}: missing parser check`,
      );
    });
  }

  test("rejects future inventory additions without checks or documentation", () => {
    const owned = [...OWNED_FLAGS, "--future"];
    expect(() => assertOwnedFlagCoverage(readmeSource, owned)).toThrow(
      "--future: missing parser check",
    );
    expect(() => assertOwnedFlagCoverage(readmeSource, owned)).toThrow(
      "--future: missing README documentation",
    );
  });

  test("a refusal-only mention is not positive documentation", () => {
    const source = readmeSource
      .replaceAll("--opus", "omitted")
      .replace("## Refusals and exit codes", "## Refusals and exit codes\n\n`--opus` is refused.");
    expect(flagsIn(source).has("--opus")).toBe(true);
    expect(() => assertOwnedFlagCoverage(source)).toThrow("--opus: missing README documentation");
  });

  test("undocumented exceptions require reasons and reject stale entries", () => {
    const source = readmeSource.replaceAll("--opus", "omitted");
    const exceptions = { "--opus": "Temporarily internal." };
    assertOwnedFlagCoverage(source, OWNED_FLAGS, CLAUDES_FLAG_CHECKS, exceptions);
    expect(() =>
      assertOwnedFlagCoverage(source, OWNED_FLAGS, CLAUDES_FLAG_CHECKS, { "--opus": " " }),
    ).toThrow("needs a reason");
    expect(() =>
      assertOwnedFlagCoverage(readmeSource, OWNED_FLAGS, CLAUDES_FLAG_CHECKS, exceptions),
    ).toThrow("stale undocumented exception");
    expect(() =>
      assertOwnedFlagCoverage(readmeSource, OWNED_FLAGS, CLAUDES_FLAG_CHECKS, {
        "--not-owned": "Not an accepted flag.",
      }),
    ).toThrow("stale undocumented exception");
  });

  test("extraction excludes prose and bare terminators but retains short aliases", () => {
    expect([...flagsIn("known-benign claude-opus-5-5 -- `-v` [--live] --model -p")]).toEqual([
      "-v",
      "--live",
      "--model",
      "-p",
    ]);
  });
  test("every flag the README mentions is owned by claudes or by claude", () => {
    const flags = flagsIn(readmeSource);
    expect(flags.size).toBeGreaterThan(0); // the extraction itself still works
    const unknown = [...flags]
      .filter(
        (flag) =>
          !CLAUDE_FLAGS.has(flag) &&
          !OWNED_FLAGS.includes(flag) &&
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
    // only recognises the reserved words, --version and --help.
    expect(dispatch(["--bogus"]).kind).toBe("passthrough");
    expect(parseLoginArgs(["--url", LOGIN_URL, "--bogus"]).ok).toBe(false);
    const { deps, err } = noConfigDoctorDeps();
    expect(await runDoctor(["--bogus"], deps)).toBe(64);
    expect(err.join("")).toContain("unknown argument");
  });
});

/**
 * The README and the help output are one contract: every flag the README
 * documents must be in the help output that applies to it, and every flag the
 * help output names must be documented in the README. The refusals table and
 * the shell flags of the install snippets are outside it — they are refusals
 * and npm's / rm's options, not options claudes accepts.
 */
function assertHelpMatchesReadme(
  source: string,
  texts: Readonly<Record<HelpScope, string>> = HELP_TEXTS,
): void {
  const documented = positiveReadmeFlags(source);
  const problems: string[] = [];
  for (const flag of documented) {
    if (REFUSED_FLAGS.has(flag) || SHELL_FLAGS.has(flag)) {
      continue;
    }
    // The applicable help output is the one whose scope owns the flag.
    const scopes = HELP_SCOPES.filter((scope) => HELP_SCOPE_FLAGS[scope].includes(flag));
    if (scopes.length === 0) {
      problems.push(`${flag}: documented in the README but no help output covers it`);
      continue;
    }
    for (const scope of scopes) {
      if (!flagsIn(texts[scope]).has(flag)) {
        problems.push(`${flag}: missing from the ${scope} --help output`);
      }
    }
  }
  for (const scope of HELP_SCOPES) {
    for (const flag of flagsIn(texts[scope])) {
      if (!documented.has(flag)) {
        problems.push(
          `${flag}: named in the ${scope} --help output but not documented in the README`,
        );
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

describe("README and help output contract", () => {
  test("every documented flag is in the applicable help output, and every named flag is documented", () => {
    assertHelpMatchesReadme(readmeSource);
  });

  test("rejects a README that drops a flag the help output names", () => {
    for (const flag of ["--model", "-p", "--url", "--live"]) {
      const source = readmeSource.replaceAll(flag, "omitted");
      expect(() => assertHelpMatchesReadme(source)).toThrow(flag);
    }
  });

  test("rejects a help output that drops a flag the README documents", () => {
    const cases: readonly { readonly scope: HelpScope; readonly flag: string }[] = [
      { scope: "top", flag: "--model" },
      { scope: "login", flag: "--url" },
      { scope: "doctor", flag: "--live" },
    ];
    for (const { scope, flag } of cases) {
      const texts: Readonly<Record<HelpScope, string>> = {
        ...HELP_TEXTS,
        [scope]: HELP_TEXTS[scope].replaceAll(flag, "omitted"),
      };
      expect(() => assertHelpMatchesReadme(readmeSource, texts)).toThrow(flag);
    }
  });

  test("the refusals table and the shell flags are outside the contract", () => {
    // --settings and --key are refusals, -g and -rf belong to npm and rm:
    // no help output may be asked to document them.
    for (const flag of [...REFUSED_FLAGS, ...SHELL_FLAGS]) {
      const named = HELP_SCOPES.some((scope) => flagsIn(HELP_TEXTS[scope]).has(flag));
      expect(named).toBe(false);
    }
  });
});

function assertDisabledGaps(source: string, features = UNSUPPORTED_FEATURES): void {
  const documented = readmeKnownGapRows(source)
    .filter((row) => /^Disabled\b/.test(row.status))
    .map((row) => {
      const feature = row.what === "Advisor tool" ? "advisor" : row.what;
      const status = row.status.match(/^Disabled \(`([^`]+)` in the generated settings\): .+$/);
      if (status === null) {
        throw new Error(`README disabled gap has malformed mechanism: ${row.what}`);
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
      return JSON.stringify({ feature, removedBy });
    })
    .sort();
  const expected = features
    .map((feature) =>
      JSON.stringify({
        feature: feature.feature,
        removedBy: feature.removedBy,
      }),
    )
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

  test("historical tracking metadata does not determine launcher policy", () => {
    assertDisabledGaps(
      readmeSource,
      UNSUPPORTED_FEATURES.map((feature) => ({ ...feature, issue: "historical metadata" })),
    );
  });
});

const ROUTER_AUDIT_VERSION = "v2.57.0";
const ROUTER_SOURCE = "https://github.com/developerz-ai/multi-ai-router/blob/";
const CLOSED_ROUTER_ISSUES = [210, 211, 213, 296, 298, 299];
const SDK_SOURCE = "apps/api/src/providers/claude-sdk/";
const FAST_SOURCE = "apps/api/src/providers/claude-fast/";
const GAP_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  WebSearch: [`${SDK_SOURCE}request.ts`],
  "Advisor tool": [`${SDK_SOURCE}request.ts`],
  "PDFs / document blocks": [`${SDK_SOURCE}prompt.ts`],
  "`count_tokens`": ["apps/api/test/integration/count-tokens.test.ts"],
  "`anthropic-beta` header": [
    `${FAST_SOURCE}invoker.ts`,
    `${FAST_SOURCE}profile.ts`,
    `${SDK_SOURCE}request.ts`,
    `${SDK_SOURCE}options.ts`,
  ],
  "Request duration": [
    "apps/api/src/config/routing-env.ts",
    "apps/api/src/config/upstream-stream.ts",
    "apps/api/src/services/dataplane/attempt.ts",
    "apps/api/src/services/dataplane/sdk-attempt.ts",
  ],
  "Working directory": [`${SDK_SOURCE}options.ts`, `${FAST_SOURCE}invoker.ts`],
  "Tool-call relay": [
    `${SDK_SOURCE}tools/register.ts`,
    `${SDK_SOURCE}options.ts`,
    `${FAST_SOURCE}invoker.ts`,
  ],
};
const FIXED_GAPS = ["PDFs / document blocks", "`anthropic-beta` header", "Working directory"];

/** Offline provenance guard, not a claim that the upstream tests ran here. */
function assertGapAudit(source: string): void {
  const section = source.match(
    /^## Known gaps through Claude subscriptions\r?\n(.*?)(?=^## |$(?![\s\S]))/ms,
  )?.[1];
  expect(section).toBeDefined();
  expect(section).toContain(`Audited against router **${ROUTER_AUDIT_VERSION}**`);
  expect(section).toContain("not a live test");
  for (const issue of CLOSED_ROUTER_ISSUES) {
    expect(section).not.toMatch(
      new RegExp(`https://github\\.com/developerz-ai/multi-ai-router/issues/${issue}\\b`),
    );
  }
  const rows = readmeKnownGapRows(source);
  expect(rows.map((row) => row.what).sort()).toEqual(Object.keys(GAP_EVIDENCE).sort());
  for (const row of rows) {
    expect(row.issue).toMatch(/^(Source|Test) inspection:/);
    for (const path of GAP_EVIDENCE[row.what] ?? []) {
      expect(row.issue).toContain(`](${ROUTER_SOURCE}${ROUTER_AUDIT_VERSION}/${path})`);
    }
    const citations = [...row.issue.matchAll(/\]\((https:\/\/[^)]+)\)/g)];
    expect(citations.length).toBeGreaterThan(0);
    for (const citation of citations) {
      expect(citation[1]).toStartWith(`${ROUTER_SOURCE}${ROUTER_AUDIT_VERSION}/`);
    }
    if (FIXED_GAPS.includes(row.what) || /\bfixed\b/i.test(row.status)) {
      expect(row.status).toContain(`Fixed by ${ROUTER_AUDIT_VERSION}:`);
    }
  }
}

describe("README versioned router audit", () => {
  test("accounts for all eight gaps with pinned, inspection-based evidence", () => {
    assertGapAudit(readmeSource);
  });

  const rows = readmeKnownGapRows(readmeSource);
  for (const row of rows) {
    for (const [label, evidence] of Object.entries({
      "missing evidence": "None",
      "changed evidence version": row.issue.replaceAll(ROUTER_AUDIT_VERSION, "v0.0.0"),
      "missing confirmation method": row.issue.replace(/^(Source|Test) inspection:/, "Evidence:"),
    })) {
      test(`rejects ${label}: ${row.what}`, () => {
        const line = readmeSource
          .split("\n")
          .find((line) => line.split("|")[1]?.trim() === row.what);
        expect(line).toBeDefined();
        const source = readmeSource.replace(line ?? "", (line ?? "").replace(row.issue, evidence));
        expect(source).not.toBe(readmeSource);
        expect(() => assertGapAudit(source)).toThrow();
      });
    }
    if (FIXED_GAPS.includes(row.what)) {
      test(`rejects missing fixed-version label: ${row.what}`, () => {
        const source = readmeSource.replace(
          row.status,
          row.status.replace(`Fixed by ${ROUTER_AUDIT_VERSION}:`, "Fixed:"),
        );
        expect(source).not.toBe(readmeSource);
        expect(() => assertGapAudit(source)).toThrow();
      });
    }
  }

  test("rejects a changed audit version", () => {
    expect(() =>
      assertGapAudit(readmeSource.replace(`**${ROUTER_AUDIT_VERSION}**`, "**v0.0.0**")),
    ).toThrow();
  });

  for (const issue of CLOSED_ROUTER_ISSUES) {
    for (const location of ["introduction", "row"]) {
      test(`rejects closed issue #${issue} in ${location}`, () => {
        const target =
          location === "introduction"
            ? "## Known gaps through Claude subscriptions"
            : (rows[0]?.issue ?? "");
        const link = ` [#${issue}](https://github.com/developerz-ai/multi-ai-router/issues/${issue})`;
        const source = readmeSource.replace(
          target,
          `${target}${location === "introduction" ? "\n" : ""}${link}`,
        );
        expect(() => assertGapAudit(source)).toThrow();
      });
    }
  }
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

/**
 * The uninstall drill's record — the acceptance evidence issue #5 asks for.
 *
 * WHY: the drill proves seven things, and a record that quietly drops one of
 * them is a record that claims more than it shows. Three documents carry the
 * evidence — the README's drill procedure, the README's block of what to paste
 * on the issue, and the brain's record of the run — so all three are checked
 * here: the procedure and the paste block must name every step, and the
 * record must carry a result per step, with a digest (or the word "absent")
 * in the two checksum-bearing rows.
 *
 * The guard is proved able to fail: every mutation below must be rejected, so
 * a record that lost a step cannot pass as a complete one.
 */

/** The seven drill results, in the order the drill takes them. */
const DRILL_STEPS: readonly string[] = [
  "1. baseline",
  "2. install",
  "3. login",
  "4. session",
  "5. uninstall",
  "6. checksum",
  "7. plain claude",
];

/** The steps whose result is a checksum of Claude Code's own settings file. */
const CHECKSUM_STEPS: readonly string[] = ["1. baseline", "6. checksum"];

/** The heading of the record in the brain. */
const RECORD_HEADING = "### The recorded dev-box run";

/** The issue the drill's results are for; the record has to name it. */
const DRILL_ISSUE_URL = "https://github.com/developerz-ai/claudes/issues/5";

/**
 * The text of a section, from its heading to the next heading of the same or
 * a higher level. A heading that is not there is an error, not an empty
 * section: a missing record must fail the guard, not pass it vacuously.
 *
 * The scan tracks fenced code blocks: a shell comment inside a fence looks
 * like a heading but is not one, and the drill's steps live in a fence.
 */
function section(source: string, heading: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`the document has no "${heading}" section`);
  }
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const body: string[] = [];
  let inFence = false;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      body.push(line);
      continue;
    }
    if (!inFence) {
      const match = /^(#{1,6})\s/.exec(line);
      if (match !== null && (match[1]?.length ?? 0) <= level) break;
    }
    body.push(line);
  }
  return body.join("\n");
}

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string; engines: { node: string }; repository: { url: string } };
const bunPin = readFileSync(new URL("../.bun-version", import.meta.url), "utf8").trim();
const SOURCE_COMMANDS = [
  `git clone ${packageMetadata.repository.url.replace(/^git\+/, "")}`,
  "cd claudes",
  "bin/setup",
  "bin/check",
  "npm i -g .",
  "claudes --version",
];
const INSTALL_REQUIREMENTS = [
  {
    heading: "# claudes",
    patterns: [
      /requires/,
      /\[multi-ai-router\]\(https:\/\/github\.com\/developerz-ai\/multi-ai-router\)/,
      /per-person `mar_live_` key/,
      /cannot talk to the Anthropic API directly/,
    ],
  },
  {
    heading: "## Install",
    patterns: [
      /available once v0\.1\.0 is published/,
      /\[#7\]\(https:\/\/github\.com\/developerz-ai\/claudes\/issues\/7\)/,
      /npm i -g @developerz\.ai\/claudes/,
    ],
  },
  {
    heading: "## Build from source",
    patterns: [
      /Node 22\+/,
      /npm \(bundled with Node\)/,
      /, git, and/,
      /Bun matching `\.bun-version`/,
      /writable npm global prefix/,
      /put its executable directory on your `PATH`/,
      /version in `package\.json`/,
      /exits 0/,
    ],
  },
];

function installSection(source: string, heading: string): string {
  const body = section(source, heading);
  return heading === "# claudes" ? (body.trim().split(/\n\s*\n/)[0] ?? "") : body;
}

function assertInstallationGuide(source: string): void {
  for (const { heading, patterns } of INSTALL_REQUIREMENTS) {
    const body = installSection(source, heading).replace(/\s+/g, " ");
    for (const pattern of patterns) expect(body).toMatch(pattern);
  }
  const build = section(source, "## Build from source");
  expect(build).toContain(`currently ${bunPin}`);
  expect(build).toContain(`currently ${packageMetadata.version}`);
  expect(packageMetadata.engines.node).toBe(">=22");
  const headings = Array.from(source.matchAll(/^## .+$/gm), (match) => match[0]);
  expect(headings[headings.indexOf("## Install") + 1]).toBe("## Build from source");
  const commands = build.match(/```sh\n([\s\S]*?)\n```/)?.[1]?.split("\n");
  expect(commands).toEqual(SOURCE_COMMANDS);
}

describe("README installation guide", () => {
  test("documents router requirements and adjacent registry/source installation", () => {
    assertInstallationGuide(readmeSource);
  });

  for (const { heading, patterns } of INSTALL_REQUIREMENTS) {
    for (const pattern of patterns) {
      test(`rejects missing or misplaced ${pattern} in ${heading}`, () => {
        const body = installSection(readmeSource, heading);
        // Preserve fences and headings: only the requirement itself may change.
        const wrapped = new RegExp(pattern.source.replaceAll(" ", "\\s+"));
        expect(body).toMatch(wrapped);
        const changed = readmeSource.replace(body, body.replace(wrapped, "omitted"));
        expect(() => assertInstallationGuide(changed)).toThrow();
        expect(() => assertInstallationGuide(`${changed}\n## Elsewhere\n${body}`)).toThrow();
      });
    }
  }

  test("rejects every omitted or reordered source step even with the drill intact", () => {
    const body = section(readmeSource, "## Build from source");
    for (const [index, command] of SOURCE_COMMANDS.entries()) {
      const missing = body.replace(`${command}\n`, "");
      expect(() => assertInstallationGuide(readmeSource.replace(body, missing))).toThrow();
      const reordered = [...SOURCE_COMMANDS];
      const next = (index + 1) % reordered.length;
      reordered[index] = SOURCE_COMMANDS[next] ?? "";
      reordered[next] = command;
      const swapped = body.replace(SOURCE_COMMANDS.join("\n"), reordered.join("\n"));
      expect(() => assertInstallationGuide(readmeSource.replace(body, swapped))).toThrow();
    }
  });

  test("rejects a source guide moved away from Install", () => {
    const heading = "## Build from source";
    const body = section(readmeSource, heading);
    const moved = readmeSource.replace(`${heading}\n${body}`, "");
    expect(() => assertInstallationGuide(`${moved}\n${heading}\n${body}`)).toThrow();
  });
});

/** The result cell of the record's row for a step, or undefined when the row is missing. */
function recordRow(record: string, step: string): string | undefined {
  for (const line of record.split(/\r?\n/)) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (match?.[1] === step) {
      return match[2] ?? "";
    }
  }
  return undefined;
}

/** Every drill step a text names — the steps it forgot are the problem. */
function assertDrillSteps(text: string, what: string): void {
  const missing = DRILL_STEPS.filter((step) => !text.includes(step));
  if (missing.length > 0) {
    throw new Error(`${what} does not name the drill steps: ${missing.join(", ")}`);
  }
}

/** The record's own contract: a result per step, and a checksum where one belongs. */
function assertDrillRecord(record: string): void {
  const problems: string[] = [];
  for (const step of DRILL_STEPS) {
    const result = recordRow(record, step);
    if (result === undefined) {
      problems.push(`${step}: no row in the record`);
      continue;
    }
    if (result.trim() === "") {
      problems.push(`${step}: the row carries no result`);
      continue;
    }
    if (
      CHECKSUM_STEPS.includes(step) &&
      !/[0-9a-f]{64}/.test(result) &&
      !/\babsent\b/.test(result)
    ) {
      problems.push(`${step}: the row carries no checksum and does not say "absent"`);
    }
  }
  if (!record.includes(DRILL_ISSUE_URL)) {
    problems.push(`the record does not name the issue it feeds: ${DRILL_ISSUE_URL}`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

describe("the uninstall drill record", () => {
  test("the README's drill procedure and its paste block name all seven steps", () => {
    assertDrillSteps(section(readmeSource, "## The uninstall drill"), "the README's drill section");
    assertDrillSteps(
      section(readmeSource, "### What to paste on the issue"),
      "the README's paste block",
    );
  });

  test("the brain's record carries every result, and the checksums with it", () => {
    assertDrillRecord(section(brainSource, RECORD_HEADING));
  });

  test("rejects a record that drops a step", () => {
    const record = section(brainSource, RECORD_HEADING);
    const dropped = record.replace(/^\| 4\. session \|[^\n]*\n/m, "");
    expect(() => assertDrillRecord(dropped)).toThrow("4. session: no row in the record");
  });

  test("rejects a record whose result is empty", () => {
    const record = section(brainSource, RECORD_HEADING);
    const emptied = record.replace(/^\| 2\. install \|[^\n]*$/m, "| 2. install |  |");
    expect(() => assertDrillRecord(emptied)).toThrow("2. install: the row carries no result");
  });

  test("rejects a checksum row that carries no digest and does not say absent", () => {
    const record = section(brainSource, RECORD_HEADING);
    const blind = record.replace(/^\| 6\. checksum \|[^\n]*$/m, "| 6. checksum | unchanged |");
    expect(() => assertDrillRecord(blind)).toThrow(
      '6. checksum: the row carries no checksum and does not say "absent"',
    );
  });

  test("rejects a record that does not name the issue it feeds", () => {
    const record = section(brainSource, RECORD_HEADING);
    const unlinked = record.replaceAll(DRILL_ISSUE_URL, "the issue");
    expect(() => assertDrillRecord(unlinked)).toThrow(
      "the record does not name the issue it feeds",
    );
  });

  test("rejects a README whose drill steps drop one", () => {
    const source = readmeSource.replaceAll("4. session", "4. a chat");
    expect(() => assertDrillSteps(section(source, "## The uninstall drill"), "the drill")).toThrow(
      "does not name the drill steps: 4. session",
    );
  });

  test("rejects a missing record instead of passing it vacuously", () => {
    expect(() => section(brainSource, "### No such record")).toThrow(
      'the document has no "### No such record" section',
    );
  });
});

/**
 * The README's local router stack — the recipe the drill's local-stack variant
 * runs. The recipe is executed here, not merely quoted: its whole point is
 * that a session line reading `credential=match` is evidence the configured
 * key travelled, so the guard proves the comparison refuses everything else
 * and that no key material reaches the recipe's log.
 */
describe("the README's local router stack", () => {
  const STACK_MARKER = "Save this as `router.mjs`:";
  const WRONG_KEY = "mar_live_WRONGKEY0123456789abcdefghijklmn";

  /** The recipe: the ```js fence that follows the marker, verbatim. */
  function stackSource(): string {
    const at = readmeSource.indexOf(STACK_MARKER);
    if (at === -1) {
      throw new Error("the README no longer introduces the local stack");
    }
    const open = readmeSource.indexOf("```js\n", at);
    if (open === -1) {
      throw new Error("the local-stack recipe has no js fence");
    }
    const close = readmeSource.indexOf("\n```", open);
    if (close === -1) {
      throw new Error("the local-stack recipe fence is never closed");
    }
    return `${readmeSource.slice(open + "```js\n".length, close)}\n`;
  }

  /** The recipe on disk, in a scratch directory the test removes after. */
  function writeStack(): string {
    const dir = mkdtempSync(join(tmpdir(), "claudes-readme-stack-"));
    const path = join(dir, "router.mjs");
    writeFileSync(path, stackSource(), "utf8");
    return path;
  }

  /** The recipe's own promise: no key material in anything it prints. */
  function assertLogCarriesNoKey(text: string): void {
    assertNoKeyFragment(text, KEY);
    assertNoKeyFragment(text, WRONG_KEY);
  }

  test("refuses to start without the drill key in its environment", () => {
    const path = writeStack();
    try {
      const res = spawnSync("node", [path], {
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("set ROUTER_KEY");
      assertLogCarriesNoKey(`${res.stdout}${res.stderr}`);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  test("answers only the drill key: none, match and mismatch in the log, 401 otherwise", async () => {
    const path = writeStack();
    const child = spawn("node", [path], {
      env: { ROUTER_KEY: KEY, PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      log += chunk;
    });
    const listening = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the local stack never listened")), 10_000);
      child.stdout?.on("data", (chunk: string) => {
        log += chunk;
        const at = log.indexOf("router: http://127.0.0.1:");
        if (at !== -1) {
          clearTimeout(timer);
          const end = log.indexOf("\n", at);
          resolve(log.slice(at, end === -1 ? undefined : end));
        }
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    try {
      const base = (await listening).slice("router: ".length).trimEnd();
      // The pre-launch health check: no credential, answered regardless.
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { version: string }).version).toBe("1.4.2");
      // The login's models request: the drill key as a Bearer token.
      const login = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(login.status).toBe(200);
      expect(((await login.json()) as { data: unknown[] }).data).toHaveLength(3);
      // A wrong credential is refused on /v1/models, not merely counted.
      const wrongModels = await fetch(`${base}/v1/models`, {
        headers: { "x-api-key": WRONG_KEY },
      });
      expect(wrongModels.status).toBe(401);
      // So is no credential at all.
      expect((await fetch(`${base}/v1/models`)).status).toBe(401);
      // The session: the drill key as x-api-key gets the assistant turn.
      const session = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1, messages: [] }),
      });
      expect(session.status).toBe(200);
      expect(await session.text()).toContain("pong");
      // And a session under the wrong key is refused before any success.
      const wrongSession = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${WRONG_KEY}` },
        body: "{}",
      });
      expect(wrongSession.status).toBe(401);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("close", () => resolve());
      });
      rmSync(dirname(path), { recursive: true, force: true });
    }
    expect(log).toContain("GET /healthz credential=none");
    expect(log).toContain("GET /v1/models credential=match");
    expect(log).toContain("GET /v1/models credential=mismatch");
    expect(log).toContain("GET /v1/models credential=none");
    expect(log).toContain("POST /v1/messages credential=match");
    expect(log).toContain("POST /v1/messages credential=mismatch");
    assertLogCarriesNoKey(log);
  }, 20_000);
});
