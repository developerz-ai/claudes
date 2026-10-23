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

/** The checkout under test; bin/check-bun-versions is exercised as shipped, from a copy of it. */
const REPO = join(import.meta.dir, "..");
const SHIPPED_GUARD = join(REPO, "bin", "check-bun-versions");
const BUN_VERSION_FILE = join(REPO, ".bun-version");
const CI_WORKFLOW = join(REPO, ".github", "workflows", "ci.yml");
const RELEASE_WORKFLOW = join(REPO, ".github", "workflows", "release.yml");

/** The pin the checkout actually ships — assertions derive it, never hardcode it. */
const CHECKOUT_PIN = readFileSync(BUN_VERSION_FILE, "utf8").trim();

/** Explicit timeout for every spawn; the bun:test default is too tight under load. */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

interface Fixture {
  /** A directory that is NOT the fixture root: the spawn cwd, so the script's own cd is exercised. */
  readonly cwd: string;
  /** The fake repo root: the guard cds to the parent of the copy it runs from. */
  readonly root: string;
  /** The copy of the shipped bin/check-bun-versions under test. */
  readonly guard: string;
}

/**
 * Rewrite the `bun-version:` key of a workflow file — the same replacement
 * bin/setup.test.ts's withCIBunVersion makes, so a drift fixture disagrees
 * through the exact channel the guard reads.
 */
function withWorkflowBunVersion(workflowYaml: string, version: string): string {
  return workflowYaml.replace(/^([ \t]*bun-version:)[ \t]*.*$/m, `$1 ${version}`);
}

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claudes-bun-versions-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

/**
 * A fake repo root: the shipped guard copied in, a .bun-version, and the two
 * workflows. The repo's real files are the default fixture contents, so the
 * agreement case is proven against what actually ships; a drift test rewrites
 * one of them. The fixture writes only into the scratch root — never the
 * checkout's own files, which a sibling run could be reading.
 */
function makeFixture(
  overrides: { bunVersion?: string | null; ciYaml?: string; releaseYaml?: string } = {},
): Fixture {
  const root = join(scratch, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  const guard = join(root, "bin", "check-bun-versions");
  copyFileSync(SHIPPED_GUARD, guard);
  chmodSync(guard, 0o755);
  if (overrides.bunVersion !== null) {
    writeFileSync(
      join(root, ".bun-version"),
      overrides.bunVersion ?? readFileSync(BUN_VERSION_FILE, "utf8"),
      "utf8",
    );
  }
  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    overrides.ciYaml ?? readFileSync(CI_WORKFLOW, "utf8"),
    "utf8",
  );
  writeFileSync(
    join(root, ".github", "workflows", "release.yml"),
    overrides.releaseYaml ?? readFileSync(RELEASE_WORKFLOW, "utf8"),
    "utf8",
  );
  const cwd = join(root, "elsewhere");
  mkdirSync(cwd, { recursive: true });
  return { cwd, root, guard };
}

/**
 * Run the fixture's copy of the guard under a closed env — never process.env
 * wholesale, so an ambient variable cannot change the outcome. The real PATH
 * stays on so `#!/usr/bin/env bash` and the guard's own `sed` resolve.
 */
function runGuard(fixture: Fixture) {
  return spawnSync(fixture.guard, [], {
    cwd: fixture.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: fixture.cwd, TERM: "dumb" },
    encoding: "utf8",
    timeout: SPAWN_TEST_TIMEOUT_MS,
  });
}

describe("bin/check-bun-versions", () => {
  test(
    "the repo's real pins agree: exit 0",
    () => {
      const fixture = makeFixture();
      const res = runGuard(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "release.yml drift: exit 1, stderr names both disagreeing values with their source paths",
    () => {
      const fixture = makeFixture({
        releaseYaml: withWorkflowBunVersion(readFileSync(RELEASE_WORKFLOW, "utf8"), "9.9.9-drift"),
      });
      const res = runGuard(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("disagree");
      // The untouched value with its source path …
      expect(res.stderr).toContain(CHECKOUT_PIN);
      expect(res.stderr).toContain(".bun-version");
      expect(res.stderr).toContain(".github/workflows/ci.yml");
      // … and the drifted value with its own source path.
      expect(res.stderr).toContain("9.9.9-drift");
      expect(res.stderr).toContain(".github/workflows/release.yml");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    ".bun-version drift: exit 1, stderr names the checkout pin and the workflow pin",
    () => {
      const fixture = makeFixture({ bunVersion: "9.9.9-checkout-drift\n" });
      const res = runGuard(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("disagree");
      expect(res.stderr).toContain("9.9.9-checkout-drift");
      expect(res.stderr).toContain(".bun-version");
      expect(res.stderr).toContain(CHECKOUT_PIN);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a missing .bun-version: exit 1 — the guard refuses rather than guessing",
    () => {
      const fixture = makeFixture({ bunVersion: null });
      const res = runGuard(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(".bun-version");
      // The workflow pins are still reported, so the message shows what was found.
      expect(res.stderr).toContain(CHECKOUT_PIN);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "an empty .bun-version: exit 1 — no pin to agree with",
    () => {
      const fixture = makeFixture({ bunVersion: "\n" });
      const res = runGuard(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(".bun-version");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
