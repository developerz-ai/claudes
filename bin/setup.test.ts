import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** The checkout under test; bin/setup is exercised as shipped, from a copy of it. */
const REPO = join(import.meta.dir, "..");
const SHIPPED_SETUP = join(REPO, "bin", "setup");
const BUN_LOCK = join(REPO, "bun.lock");
const CI_WORKFLOW = join(REPO, ".github", "workflows", "ci.yml");

/** The two devDependency bins bin/check resolves by path: a tree without them is unusable. */
const CHECK_BINS = ["biome", "tsc"] as const;

/** Explicit timeout for every spawn; the bun:test default is too tight under load. */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

/**
 * The fake bun. It records every argv it was called with (one line per call), so
 * a test can assert both that an install ran and that the `--frozen-lockfile`
 * flag was the one it ran under, and answers `--version` from the environment —
 * so no real bun is invoked, no lockfile is written, and the network is untouched.
 */
const FAKE_BUN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_BUN_LOG"
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' "\${FAKE_BUN_VERSION:-0.0.0-fake}"
  exit 0
fi
if [ "\${1:-}" = "install" ]; then
  if [ -n "\${FAKE_BUN_INSTALL_OUT:-}" ]; then
    printf '%s\\n' "$FAKE_BUN_INSTALL_OUT"
  fi
  exit "\${FAKE_BUN_INSTALL_EXIT:-0}"
fi
printf 'fake bun: unexpected argv: %s\\n' "$*" >&2
exit 64
`;

interface Lockfile {
  readonly lockfileVersion?: number;
  readonly workspaces?: { readonly "": { readonly devDependencies?: Record<string, string> } };
}

interface Fixture {
  /** A directory that is NOT the fixture root: the spawn cwd and the child's HOME. */
  readonly cwd: string;
  /** The fake repo root: bin/setup cds to the parent of the copy it runs from. */
  readonly root: string;
  /** The copy of the shipped bin/setup under test. */
  readonly setup: string;
  /** Holds the fake bun, first on the child's PATH. */
  readonly stubBin: string;
  /** One line per fake-bun invocation; absent when bun was never called. */
  readonly bunLog: string;
}

/** bun.lock is JSON with trailing commas; strip them the way bin/setup does. */
function parseLock(raw: string): Lockfile {
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")) as Lockfile;
}

function devDependencies(lock: Lockfile): Record<string, string> {
  return lock.workspaces?.[""]?.devDependencies ?? {};
}

/**
 * The repo's own bun.lock with one devDependency pin rewritten to a fixture
 * version. A bin/setup that compared against its own hardcoded copy of the pins
 * would find this tree unsatisfied, so the skip branch only passes on a lockfile
 * read at run time.
 */
function lockWithPin(name: string, pin: string): string {
  const raw = readFileSync(BUN_LOCK, "utf8");
  const at = raw.indexOf(`"${name}": `);
  const lineEnd = at === -1 ? -1 : raw.indexOf("\n", at);
  if (lineEnd === -1) {
    throw new Error(`bun.lock declares no ${name} pin to rewrite`);
  }
  return `${raw.slice(0, at)}"${name}": "${pin}",${raw.slice(lineEnd)}`;
}

/** The CI-pinned bun version, exactly as bin/setup greps it out of ci.yml. */
function withCIBunVersion(ciYaml: string, version: string): string {
  return ciYaml.replace(/^([ \t]*bun-version:)[ \t]*.*$/m, `$1 ${version}`);
}

/** The argv lines the fake bun was called with, in order. */
function bunCalls(fixture: Fixture): string[] {
  return existsSync(fixture.bunLog)
    ? readFileSync(fixture.bunLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

let scratch = "";
/** Fixtures built inside one test must not share a path, least of all the bun log. */
let fixtures = 0;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claudes-setup-"));
  fixtures = 0;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

/**
 * A fake repo root: the shipped bin/setup copied in, a lockfile, a CI workflow
 * and the fake bun. Nothing here is the checkout's own bun.lock or node_modules —
 * a sibling run in the same tree would collide — so the fixture writes only into
 * the scratch root and there is nothing to snapshot and restore.
 */
function makeFixture(lock: string, ciYaml = readFileSync(CI_WORKFLOW, "utf8")): Fixture {
  const id = fixtures++;
  const root = join(scratch, `repo-${id}`);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  const setup = join(root, "bin", "setup");
  copyFileSync(SHIPPED_SETUP, setup);
  chmodSync(setup, 0o755);
  writeFileSync(join(root, "bun.lock"), lock, "utf8");
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), ciYaml, "utf8");
  const stubBin = join(scratch, `stub-bin-${id}`);
  mkdirSync(stubBin, { recursive: true });
  const bun = join(stubBin, "bun");
  writeFileSync(bun, FAKE_BUN, "utf8");
  chmodSync(bun, 0o755);
  // A cwd that is not the root, so the `cd` the script does is exercised.
  const cwd = join(scratch, `elsewhere-${id}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, root, setup, stubBin, bunLog: join(root, "fake-bun-invocations") };
}

/** node_modules holding every devDependency pin the lockfile declares, at that pin. */
function installPins(root: string, pins: Record<string, string>): void {
  for (const [name, pin] of Object.entries(pins)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: pin }), "utf8");
  }
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  for (const tool of CHECK_BINS) {
    const bin = join(binDir, tool);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(bin, 0o755);
  }
}

/**
 * Run the fixture's copy of bin/setup under a closed env — never process.env
 * wholesale, so an ambient variable cannot change which branch it takes. The
 * real PATH stays on so the fake's `#!/usr/bin/env bash` and bin/setup's own
 * `node` and `sed` resolve.
 */
function runSetup(fixture: Fixture, env: Record<string, string | undefined> = {}) {
  return spawnSync(fixture.setup, [], {
    cwd: fixture.cwd,
    env: {
      PATH: `${fixture.stubBin}${delimiter}${process.env.PATH ?? ""}`,
      HOME: fixture.cwd,
      TERM: "dumb",
      FAKE_BUN_LOG: fixture.bunLog,
      FAKE_BUN_INSTALL_EXIT: "0",
      ...env,
    },
    encoding: "utf8",
    timeout: SPAWN_TEST_TIMEOUT_MS,
  });
}

/**
 * `label` followed by its `value`. The gap between them is layout the diagnostic
 * owns, not the contract, so it is matched loosely; the two texts are not.
 */
function labelled(label: string, value: string): RegExp {
  const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${regexEscape(label)}\\s+${regexEscape(value)}\\b`);
}

describe("bin/setup on a checkout that already holds bun.lock's pins", () => {
  const expectInstallSkipped = (lock: string, pinCount: number, lockfileVersion: number) => {
    const fixture = makeFixture(lock);
    installPins(fixture.root, devDependencies(parseLock(lock)));
    const res = runSetup(fixture);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    // The skip and the reason it is safe, on one line.
    expect(res.stdout).toContain("already satisfied");
    expect(res.stdout).toContain("skipped 'bun install --frozen-lockfile'");
    expect(res.stdout).toMatch(
      labelled("node_modules holds all", `${pinCount} devDependency pins bun.lock declares`),
    );
    expect(res.stdout).toMatch(labelled("(lockfileVersion", String(lockfileVersion)));
    expect(res.stdout).not.toContain("running bun install");
    // The strongest statement of "skipped": the fake bun was never called at all.
    expect(bunCalls(fixture)).toEqual([]);
  };

  test(
    "the repo's own lockfile: exit 0, one line naming the pins it skipped for",
    () => {
      // The real file, trailing commas and all: bin/setup has to parse it to skip.
      const lock = readFileSync(BUN_LOCK, "utf8");
      const parsed = parseLock(lock);
      const pinCount = Object.keys(devDependencies(parsed)).length;
      expectInstallSkipped(lock, pinCount, Number(parsed.lockfileVersion));
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a lockfile whose pins are not the repo's: still skipped, so the pins are read at run time",
    () => {
      const lock = lockWithPin("zod", "9.9.9-fixture");
      expectInstallSkipped(lock, Object.keys(devDependencies(parseLock(lock))).length, 2);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a missing node_modules/.bin entry: not a usable tree, so it installs",
    () => {
      // Every tool bin/check resolves, one run each — the assertion follows the
      // constant, so a tool added there is covered without editing this test.
      const lock = readFileSync(BUN_LOCK, "utf8");
      for (const tool of CHECK_BINS) {
        const fixture = makeFixture(lock);
        installPins(fixture.root, devDependencies(parseLock(lock)));
        rmSync(join(fixture.root, "node_modules", ".bin", tool));
        const res = runSetup(fixture);
        expect(res.error).toBeUndefined();
        expect(res.status).toBe(0);
        expect(res.stdout).toContain(`node_modules/.bin/${tool} is missing`);
        expect(res.stdout).toContain("running bun install --frozen-lockfile");
        expect(bunCalls(fixture)).toEqual(["install --frozen-lockfile"]);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("bin/setup when bun refuses the frozen install", () => {
  /** A refused install: no node_modules, so the tree is unsatisfied whatever bun says. */
  function refusingFixture(ciYaml?: string): Fixture {
    return makeFixture(readFileSync(BUN_LOCK, "utf8"), ciYaml);
  }

  test(
    "exit 1, and stderr names the three numbers that classify the refusal",
    () => {
      const fixture = refusingFixture();
      const res = runSetup(fixture, {
        FAKE_BUN_INSTALL_OUT: "lockfile had changes, but lockfile had no changes",
        FAKE_BUN_INSTALL_EXIT: "1",
        FAKE_BUN_VERSION: "1.1.9",
      });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      // The bare refusal is still shown, and never silently replaced.
      expect(res.stdout).toContain("lockfile had changes");
      expect(res.stderr).toMatch(labelled("bun --version:", "1.1.9"));
      expect(res.stderr).toMatch(labelled("bun.lock lockfileVersion:", "2"));
      expect(res.stderr).toMatch(labelled("bun version CI installs:", "1.4.3"));
      // A refusal is not a reason to re-run the install without --frozen-lockfile.
      expect(bunCalls(fixture)).toEqual(["install --frozen-lockfile", "--version"]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "the CI-pinned version comes from ci.yml, not from the script",
    () => {
      const fixture = refusingFixture(
        withCIBunVersion(readFileSync(CI_WORKFLOW, "utf8"), "9.9.9-ci-fixture"),
      );
      const res = runSetup(fixture, { FAKE_BUN_INSTALL_EXIT: "1" });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(labelled("bun version CI installs:", "9.9.9-ci-fixture"));
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("bin/setup when bun.lock declares nothing to check", () => {
  test(
    "an unparseable lockfile falls through to the install, under --frozen-lockfile",
    () => {
      const fixture = makeFixture("this is not a lockfile {\n");
      const res = runSetup(fixture);
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("bun.lock declares no devDependency pin to check");
      expect(res.stdout).toContain("running bun install --frozen-lockfile");
      expect(bunCalls(fixture)).toEqual(["install --frozen-lockfile"]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
