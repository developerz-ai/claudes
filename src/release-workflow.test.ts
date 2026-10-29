import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The digest-verified pinned-npm install in .github/workflows/release.yml is
 * the release supply-chain guard, and the workflow carries one copy per job
 * that packs or publishes with it. Every copy must stay byte-identical, the
 * digest check must fail closed (an "npm tarball digest mismatch" ::error
 * followed by exit 1) before anything is installed, the npm --version guard
 * must follow the install, and the build job must install before it packs
 * the release tarball. Nothing else in the repo references these steps, so
 * this file is the only guard keeping an edit to one copy from landing green.
 */

const WORKFLOW_PATH = join(import.meta.dir, "..", ".github", "workflows", "release.yml");
const LINES = readFileSync(WORKFLOW_PATH, "utf8").split("\n");

// The step name carries GitHub Actions' literal `${{ env.NPM_VERSION }}`
// expression — YAML text, not a JS placeholder — so it is pinned with an
// anchored regex; a plain string literal trips Biome's
// noTemplateCurlyInString heuristic and the gate errors on warnings.
const INSTALL_STEP_NAME_PATTERN =
  /^Install pinned npm \$\{\{ env\.NPM_VERSION \}\} from a verified tarball$/;

interface NamedStep {
  job: string;
  index: number;
  name: string;
}

interface InstallStep {
  job: string;
  index: number;
  run: string;
}

// Job ids sit at two-space indent directly under `jobs:` (build, publish,
// verify, dry-run); every `key:` at that indent in this file is one of them.
const jobStarts: Array<{ id: string; index: number }> = [];
for (let i = 0; i < LINES.length; i++) {
  const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(LINES[i] ?? "");
  const id = match?.[1];
  if (id !== undefined) jobStarts.push({ id, index: i });
}

function jobOf(lineIndex: number): string {
  let job = "";
  for (const { id, index } of jobStarts) {
    if (index < lineIndex) job = id;
  }
  return job;
}

const stepNames: NamedStep[] = [];
for (let i = 0; i < LINES.length; i++) {
  const match = /^ *- name: (.*)$/.exec(LINES[i] ?? "");
  const name = match?.[1];
  if (name !== undefined) stepNames.push({ job: jobOf(i), index: i, name });
}

function indentAt(lineIndex: number): number {
  const line = LINES[lineIndex] ?? "";
  let width = 0;
  while (line[width] === " ") width++;
  return width;
}

/** The dedented `run: |` block scalar that belongs to the named step. */
function runBodyOf(nameIndex: number): string {
  const stepIndent = indentAt(nameIndex);
  const body: string[] = [];
  let runKeyIndent = -1;
  let bodyIndent = -1;
  for (let i = nameIndex + 1; i < LINES.length; i++) {
    const line = LINES[i] ?? "";
    const indent = indentAt(i);
    if (runKeyIndent < 0) {
      if (/^ *run: \|$/.test(line)) {
        runKeyIndent = indent;
      } else if (indent <= stepIndent && line.trim() !== "") {
        break; // the next step started before this one declared a run block
      }
      continue;
    }
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (indent <= runKeyIndent) break; // the block scalar ended
    if (bodyIndent < 0) bodyIndent = indent;
    body.push(line.slice(bodyIndent));
  }
  while (body.length > 0 && body[body.length - 1] === "") {
    body.pop();
  }
  return body.join("\n");
}

const installSteps: InstallStep[] = stepNames
  .filter((step) => INSTALL_STEP_NAME_PATTERN.test(step.name))
  .map((step) => ({ ...step, run: runBodyOf(step.index) }));

describe("release.yml Install pinned npm", () => {
  test("every copy is named alike and carries a byte-identical run body", () => {
    expect(installSteps.length).toBeGreaterThanOrEqual(2);
    const jobs = installSteps.map((step) => step.job);
    expect(jobs).toContain("build");
    expect(jobs).toContain("publish");
    const build = installSteps.find((step) => step.job === "build");
    expect(build).toBeDefined();
    if (build === undefined) return;
    // Derived from the file, not from a hardcoded list: a copy added to a
    // new job is covered too, and a copy that drifts from the rest fails.
    for (const step of installSteps) {
      expect(step.run).toBe(build.run);
    }
  });

  test("the digest check fails closed before install; the version guard follows", () => {
    expect(installSteps.length).toBeGreaterThanOrEqual(2);
    for (const step of installSteps) {
      const digestError = step.run.indexOf("::error title=npm tarball digest mismatch");
      const digestExit = step.run.indexOf("exit 1", Math.max(digestError, 0));
      const install = step.run.indexOf("npm install -g ./npm.tgz");
      const versionGuard = step.run.indexOf('if [ "$(npm --version)" != "$NPM_VERSION" ]; then');
      expect(digestError).toBeGreaterThan(-1);
      // The refusal exits 1 before the install: a mismatched digest must
      // never reach `npm install -g`.
      expect(digestExit).toBeGreaterThan(digestError);
      expect(install).toBeGreaterThan(digestExit);
      expect(versionGuard).toBeGreaterThan(install);
    }
  });

  test("the build job installs pinned npm immediately before packing the tarball", () => {
    const build = installSteps.find((step) => step.job === "build");
    expect(build).toBeDefined();
    if (build === undefined) return;
    const pack = stepNames.find((step) => step.name === "Pack and verify tarball");
    expect(pack?.job).toBe("build");
    const next = stepNames.find((step) => step.index > build.index);
    expect(next?.job).toBe("build");
    expect(next?.name).toBe("Pack and verify tarball");
  });
});
