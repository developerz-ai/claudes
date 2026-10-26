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
 * bun, biome or tsc decides anything: precondition scenarios stop at or before
 * the loop; artifact scenarios add local stubs to reach the shipped smoke checks.
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
    env: {
      PATH: `${join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: fixture.cwd,
      TERM: "dumb",
    },
    encoding: "utf8",
    timeout: SPAWN_TEST_TIMEOUT_MS,
  });
}

function fixtureKeyBody(): string {
  const match = /^CHECK_KEY="mar_live_([A-Za-z0-9_-]{32})"$/m.exec(
    readFileSync(SHIPPED_CHECK, "utf8"),
  );
  if (!match?.[1]) throw new Error("bin/check: synthetic CHECK_KEY assignment not found");
  return match[1];
}

/** The version the shipped gate's synthetic router answers with. */
function fixtureRouterVersion(): string {
  const match = /^CHECK_ROUTER_VERSION="([^"]+)"$/m.exec(readFileSync(SHIPPED_CHECK, "utf8"));
  if (!match?.[1]) {
    throw new Error("bin/check: synthetic CHECK_ROUTER_VERSION assignment not found");
  }
  return match[1];
}

const CHECK_KEY_BODY = fixtureKeyBody();
const CHECK_ROUTER_VERSION = fixtureRouterVersion();
const LEAK_DIAGNOSTIC = "bin/check: ./dist/claudes.js doctor leaked key bytes";

/**
 * The two router-controlled titles the keyed smoke requires: the router's own
 * version and the live request's request id. A `leak` replaces both router
 * answers with key material — the shape of the regression the gate exists to
 * catch — while leaving the titles recognisable, so the gate reaches its leak
 * guard instead of stopping at a title assertion the leak itself would break.
 * The base URL is a fixture's own: the gate never connects to it, and the
 * synthetic router's real port is the OS's choice.
 */
function doctorTitles(leak = ""): string {
  const version = leak === "" ? CHECK_ROUTER_VERSION : leak;
  const requestId = leak === "" ? "withheld" : leak;
  return (
    `[PASS] router http://127.0.0.1:1 (version ${version})\n` +
    `[PASS] live request: POST /v1/messages answered HTTP 200 (request id ${requestId})\n`
  );
}

/** Never include the matched material in a test failure, even if the guard regresses. */
function assertSafeDiagnostics(output: string): void {
  let leaked = output.includes(`mar_live_${CHECK_KEY_BODY}`);
  for (let i = 0; i <= CHECK_KEY_BODY.length - 8; i++) {
    leaked ||= output.includes(CHECK_KEY_BODY.slice(i, i + 8));
  }
  expect(leaked).toBe(false);
}

/**
 * The real node, as an absolute path: a PATH stub must delegate to it for
 * every call except the one it refuses, and the gate needs node itself for
 * its version step and its leak guard. Probed by running it, so a broken
 * shim on PATH is not mistaken for a working node.
 */
function realNodePath(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "node");
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status === 0) return candidate;
  }
  throw new Error("bin/check: no working node on PATH for the fixture's node stub");
}

/**
 * A PATH stub that refuses ONLY the synthetic router script — recognised by
 * its file name — and delegates every other call to the real node. The
 * router then dies without reporting a base URL, so the gate's base-URL
 * refusal is the only thing that can stop the run.
 */
function stubNodeRefusingRouter(fixture: Fixture): void {
  const path = join(fixture.root, "bin", "node");
  writeFileSync(
    path,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *router.mjs)
      echo "fixture node: refusing to run the synthetic router" >&2
      exit 1
      ;;
  esac
done
exec "${realNodePath()}" "$@"
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

/**
 * No build, recursive test suite, network, or real CLI: only the shipped
 * shell assertions. `doctorExitCode` is the exit code the fake claudes.js
 * takes for the doctor run against the keyed config.
 */
function makeArtifactFixture(stdout: string, stderr: string, doctorExitCode = 1): Fixture {
  const fixture = makeFixture();
  for (const [name, script] of [
    ["bun", "#!/bin/sh\nexit 0\n"],
    ["uname", "#!/bin/sh\necho FixtureOS\n"],
  ]) {
    if (name === undefined || script === undefined) throw new Error("invalid tool stub");
    const path = join(fixture.root, "bin", name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(
    join(fixture.root, "doctor-output.json"),
    JSON.stringify({ stdout, stderr, exitCode: doctorExitCode }),
  );
  mkdirSync(join(fixture.root, "dist"));
  const cli = join(fixture.root, "dist", "claudes.js");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const config = path.join(process.env.XDG_CONFIG_HOME || "", "claudes", "config.json");
switch (process.argv[2]) {
  case "--version": console.log("0.0.0"); break;
  case "login": console.error("usage"); process.exitCode = 64; break;
  case "doctor": {
    if (fs.existsSync(config)) {
      const output = JSON.parse(fs.readFileSync(path.join(root, "doctor-output.json"), "utf8"));
      process.stdout.write(output.stdout);
      process.stderr.write(output.stderr);
      process.exitCode = typeof output.exitCode === "number" ? output.exitCode : 1;
    } else {
      console.log("FAIL no config");
      process.exitCode = 1;
    }
    break;
  }
  case "key": process.stdout.write(JSON.parse(fs.readFileSync(config, "utf8")).key); break;
  default:
    console.error("no claudes config: run \u0060claudes login --url <router>\u0060");
    process.exitCode = 78;
}
`,
  );
  chmodSync(cli, 0o755);
  return fixture;
}

describe("bin/check keyed doctor artifact assertion", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    for (let i = 0; i <= CHECK_KEY_BODY.length - 8; i++) {
      test(
        `rejects prefix-free window ${i} on ${stream}`,
        () => {
          const fragment = CHECK_KEY_BODY.slice(i, i + 8);
          const fixture = makeArtifactFixture(
            stream === "stdout" ? doctorTitles(fragment) : "",
            stream === "stderr" ? doctorTitles(fragment) : "",
          );
          const res = runCheck(fixture);
          assertSafeDiagnostics(res.stdout + res.stderr);
          expect(res.error === undefined).toBe(true);
          expect(res.status).toBe(1);
          expect(res.stderr === `${LEAK_DIAGNOSTIC}\n`).toBe(true);
        },
        SPAWN_TEST_TIMEOUT_MS,
      );
    }
  }

  test(
    "rejects the whole key inside the router-controlled titles",
    () => {
      const fixture = makeArtifactFixture(doctorTitles(`mar_live_${CHECK_KEY_BODY}`), "");
      const res = runCheck(fixture);
      assertSafeDiagnostics(res.stdout + res.stderr);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(1);
      expect(res.stderr === `${LEAK_DIAGNOSTIC}\n`).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "rejects a bare key-body window inside the router-controlled titles",
    () => {
      const fixture = makeArtifactFixture(doctorTitles(CHECK_KEY_BODY.slice(0, 8)), "");
      const res = runCheck(fixture);
      assertSafeDiagnostics(res.stdout + res.stderr);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(1);
      expect(res.stderr === `${LEAK_DIAGNOSTIC}\n`).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "fails when the doctor output carries no router version title",
    () => {
      const fixture = makeArtifactFixture(
        "[PASS] live request: POST /v1/messages answered HTTP 200 (request id withheld)\n",
        "",
      );
      const res = runCheck(fixture);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("printed no router version title");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "fails when the doctor output carries no live request id title",
    () => {
      const fixture = makeArtifactFixture(
        `[PASS] router http://127.0.0.1:1 (version ${CHECK_ROUTER_VERSION})\n`,
        "",
      );
      const res = runCheck(fixture);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("printed no live request id title");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "fails with the router's own stderr when the synthetic router reports no base URL",
    () => {
      const fixture = makeArtifactFixture(doctorTitles(), "");
      stubNodeRefusingRouter(fixture);
      const res = runCheck(fixture);
      assertSafeDiagnostics(res.stdout + res.stderr);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("the synthetic router did not report a base URL");
      // The captured router stderr names the cause of the silence.
      expect(res.stderr).toContain("fixture node: refusing to run the synthetic router");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "fails when the keyed doctor exits with a code that is neither 0 nor 1",
    () => {
      const fixture = makeArtifactFixture(doctorTitles(), "", 64);
      const res = runCheck(fixture);
      assertSafeDiagnostics(res.stdout + res.stderr);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("doctor --live exited 64, expected 0 or 1");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "permits safe output including the redacted display prefix",
    () => {
      const res = runCheck(
        makeArtifactFixture(`${doctorTitles()}PASS config mar_live_…\n`, "FAIL runtime\n"),
      );
      assertSafeDiagnostics(res.stdout + res.stderr);
      expect(res.error === undefined).toBe(true);
      expect(res.status).toBe(0);
      expect(res.stderr === "").toBe(true);
      expect(res.stdout.includes("skipping the pty refusal check")).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

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
