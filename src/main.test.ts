import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_CONFIG_MESSAGE } from "./config/load";
import { scrub } from "./router/errors";
import { assertNoKeyFragment } from "./test-support/redact";
import { VERSION } from "./version";

/**
 * src/main.ts as a child process (`bun src/main.ts`): the only place the argv
 * slicing, the reserved-word routing and the exit codes are observable at
 * once. An in-process assertion would need main.ts to export an injectable
 * main() plus an "am I the entry point" guard, so the CLI is driven the way a
 * user drives it instead.
 */
const MAIN = join(import.meta.dir, "main.ts");
const SPAWN_TEST_TIMEOUT_MS = 30_000;

let scratch: string;
let childEnv: Record<string, string>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claudes-main-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  // A closed env — never process.env wholesale — so an ambient
  // CLAUDE_CODE_USE_* (a remote Claude Code session exports one) or an ambient
  // ANTHROPIC_* cannot flip an answer, and the developer's own config is
  // never read. PATH holds an empty bin dir, so doctor finds no `claude`
  // there: its `claude --version` probe never runs and nothing reaches the
  // network.
  childEnv = {
    PATH: bin,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    TERM: "dumb",
  };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `bun src/main.ts <args>` with a closed stdin (nothing can block on a
 * read) and the closed env above.
 */
function runMain(args: readonly string[]): ChildRun {
  const res = spawnSync(process.execPath, [MAIN, ...args], {
    env: childEnv,
    cwd: scratch,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: SPAWN_TEST_TIMEOUT_MS,
  });
  if (res.error !== undefined) {
    throw res.error;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * The captured output must carry no router key. scrub() rewrites EVERY
 * occurrence of the prefix, bare ones included — its body may be empty — so a
 * rewritten message can hold no key at all (src/commands/login.ts names the
 * prefix in plain prose). The assertion proves only that the output never
 * mentions the prefix.
 */
function expectNoKeyMaterial(text: string): void {
  expect(scrub(text)).toBe(text);
}

describe("claudes main through a real process (bun src/main.ts)", () => {
  test("--version: VERSION on stdout, exit 0", () => {
    const res = runMain(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${VERSION}\n`);
    expect(res.stderr).toBe("");
    expectNoKeyMaterial(res.stdout);
  });

  test("-v: the same answer as --version", () => {
    const res = runMain(["-v"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${VERSION}\n`);
    expect(res.stderr).toBe("");
  });

  test("login: the argv.slice(1) handoff reaches the login parser", () => {
    const res = runMain(["login", "--bogus"]);
    expect(res.status).toBe(64);
    // parseLoginArgs numbers positions from 1 of the argv it was handed, so
    // "#1" is only possible when runLogin received exactly ["--bogus"]: a
    // missing slice would make the reserved word itself argument #1.
    expect(res.stderr).toContain("claudes login: unknown option #1");
    expect(res.stderr).not.toContain("unexpected argument");
    expect(res.stdout).toBe("");
    expectNoKeyMaterial(res.stderr);
  });

  const doctorKey = `mar_live_${"SyntheticDoctorKeyBody0123456789AB"}`;
  const rejectedDoctorArgs = [
    "--nonsense",
    "doctor-sensitive-sentinel-7d39",
    doctorKey,
    doctorKey.slice(9, 25),
    "--token=doctor-sensitive-sentinel-7d39",
    `--token=${doctorKey}`,
    "doctor-escape-\u001b[31m-sentinel",
    "doctor-osc-\u001b]0;sentinel\u0007",
    "doctor-return-\r-sentinel",
    "doctor-newline-\n-sentinel",
    "doctor-tab-\t-sentinel",
    "doctor-backspace-\b-sentinel",
    "doctor-delete-\u007f-sentinel",
  ];
  for (const prefix of [[], ["--live"]]) {
    for (const [index, value] of rejectedDoctorArgs.entries()) {
      test(`doctor handoff case ${index} reports position ${prefix.length + 1} without input`, () => {
        const res = runMain(["doctor", ...prefix, value]);
        expect(res.status).toBe(64);
        // Positions exclude the command word; #2 also proves --live was accepted.
        expect(res.stderr).toBe(
          `claudes doctor: unknown argument #${prefix.length + 1}\nusage: claudes doctor [--live]\n`,
        );
        expect(res.stdout).toBe("");
        expect(res.stderr).not.toContain(value);
        for (const byte of [7, 8, 9, 13, 27, 127]) {
          expect(res.stderr).not.toContain(String.fromCharCode(byte));
        }
        assertNoKeyFragment(res.stdout + res.stderr, doctorKey);
        expectNoKeyMaterial(res.stderr);
      });
    }
  }

  test("doctor with no config: exit 1 and a [FAIL] line", () => {
    const res = runMain(["doctor"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("[FAIL] config");
    expect(res.stdout).toContain(MISSING_CONFIG_MESSAGE);
    expectNoKeyMaterial(res.stdout);
    expectNoKeyMaterial(res.stderr);
  });

  test("a non-reserved argument: the passthrough path, exit 78 without a config", () => {
    const res = runMain(["--help"]);
    expect(res.status).toBe(78);
    expect(res.stderr).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
    expect(res.stdout).toBe("");
    expectNoKeyMaterial(res.stderr);
  });
});
