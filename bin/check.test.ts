import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The checkout under test; bin/check is exercised as shipped, from a copy of it. */
const REPO = join(import.meta.dir, "..");
const SHIPPED_CHECK = join(REPO, "bin", "check");
const SHIPPED_GUARD = join(REPO, "bin", "check-bun-versions");
const BUN_VERSION_FILE = join(REPO, ".bun-version");
const CI_WORKFLOW = join(REPO, ".github", "workflows", "ci.yml");
const RELEASE_WORKFLOW = join(REPO, ".github", "workflows", "release.yml");

/**
 * Exit 75 is the verify-change contract's reserved code
 * (.claude/skills/verify-change/SKILL.md): "a resource the gate NEEDS is
 * unreachable — it refused to grade", so the platform blames the environment,
 * never the change. Any other non-zero means the gate ran and the change is red.
 */
const GATE_REFUSED_TO_GRADE = 75;

/** Explicit timeout for every spawn; the bun:test default is too tight under load. */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

/**
 * The tools bin/check's presence loop iterates, read from the shipped script
 * itself. The loop is the production constant here; deriving the iteration
 * from it (instead of hardcoding "biome tsc") keeps a tool added to bin/check
 * covered by this file without an edit.
 */
function checkTools(): string[] {
  const line = readFileSync(SHIPPED_CHECK, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith("for tool in ") && candidate.endsWith("; do"));
  if (line === undefined) {
    throw new Error("bin/check: no `for tool in …; do` presence loop found");
  }
  const list = line.slice("for tool in ".length, line.length - "; do".length);
  const tools = list
    .trim()
    .split(/\s+/)
    .filter((tool) => tool !== "");
  if (tools.length === 0) {
    throw new Error("bin/check: the presence loop iterates no tools");
  }
  return tools;
}

const CHECK_TOOLS = checkTools();

interface Fixture {
  /** A directory that is NOT the fixture root: the spawn cwd and the child's HOME. */
  readonly cwd: string;
  /** The fake repo root: bin/check cds to the parent of the copy it runs from. */
  readonly root: string;
  /** The copy of the shipped bin/check under test. */
  readonly check: string;
}

/**
 * Rewrite the `bun-version:` key of a workflow file — the same replacement
 * bin/check-bun-versions.test.ts makes, so drift reaches bin/check through the
 * exact channel its first guard reads.
 */
function withWorkflowBunVersion(workflowYaml: string, version: string): string {
  return workflowYaml.replace(/^([ \t]*bun-version:)[ \t]*.*$/m, `$1 ${version}`);
}

let scratch = "";
/** Fixtures built inside one test must not share a path. */
let fixtures = 0;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claudes-check-"));
  fixtures = 0;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

/**
 * A fake repo root: the shipped bin/check and bin/check-bun-versions copied in
 * and chmod 755, the REAL .bun-version, ci.yml and release.yml so the pin guard
 * passes and the tool-presence loop is what decides the outcome, and a no-op
 * executable stub for every tool the loop iterates. Nothing of the checkout's
 * own is written — a sibling run in the same tree would collide — and no host
 * bun, biome or tsc decides anything: every scenario below stops at or before
 * the loop.
 */
function makeFixture(overrides: { releaseYaml?: string } = {}): Fixture {
  const id = fixtures++;
  const root = join(scratch, `repo-${id}`);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  const check = join(root, "bin", "check");
  copyFileSync(SHIPPED_CHECK, check);
  chmodSync(check, 0o755);
  const guard = join(root, "bin", "check-bun-versions");
  copyFileSync(SHIPPED_GUARD, guard);
  chmodSync(guard, 0o755);
  copyFileSync(BUN_VERSION_FILE, join(root, ".bun-version"));
  const workflows = join(root, ".github", "workflows");
  writeFileSync(join(workflows, "ci.yml"), readFileSync(CI_WORKFLOW, "utf8"), "utf8");
  writeFileSync(
    join(workflows, "release.yml"),
    overrides.releaseYaml ?? readFileSync(RELEASE_WORKFLOW, "utf8"),
    "utf8",
  );
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  for (const tool of CHECK_TOOLS) {
    const stub = join(binDir, tool);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(stub, 0o755);
  }
  // A cwd that is not the root, so the `cd` the script does is exercised.
  const cwd = join(scratch, `elsewhere-${id}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, root, check };
}

/**
 * Run the fixture's copy of bin/check under a closed env — never process.env
 * wholesale, so an ambient variable cannot change the outcome. The real PATH
 * stays on so `sh`, `bash`, `sed` and `head` resolve.
 */
function runCheck(fixture: Fixture) {
  return spawnSync(fixture.check, [], {
    cwd: fixture.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: fixture.cwd, TERM: "dumb" },
    encoding: "utf8",
    timeout: SPAWN_TEST_TIMEOUT_MS,
  });
}

describe("bin/check precondition classification", () => {
  test(
    "a missing node_modules/.bin tool: exit 75 — the gate refused to grade, not a red change",
    () => {
      // Every tool the loop iterates, one run each: the assertion follows the
      // loop's own list, so a tool added there is covered without editing this.
      for (const tool of CHECK_TOOLS) {
        const fixture = makeFixture();
        rmSync(join(fixture.root, "node_modules", ".bin", tool));
        const res = runCheck(fixture);
        expect(res.error).toBeUndefined();
        // The pin guard passed first (its agreement line is on stdout), so the
        // 75 is the tool loop's classification — and it is not exit 1.
        expect(res.stdout).toContain("agree");
        expect(res.status).toBe(GATE_REFUSED_TO_GRADE);
        expect(res.stderr).toContain(`node_modules/.bin/${tool} not found`);
        // The remedy is the repo's own install command.
        expect(res.stderr).toContain("bin/setup");
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a drifted release.yml bun pin: exit 1 — an ordinary failure is never 75",
    () => {
      const fixture = makeFixture({
        releaseYaml: withWorkflowBunVersion(readFileSync(RELEASE_WORKFLOW, "utf8"), "9.9.9-drift"),
      });
      const res = runCheck(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      // The refusal is the pin guard's own, before any tool is consulted.
      expect(res.stderr).toContain("disagree");
      expect(res.stderr).toContain("9.9.9-drift");
      expect(res.stdout).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
