import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";

type Mapping = Record<string, unknown>;

const SOURCE = readFileSync(join(import.meta.dir, "release.yml"), "utf8");
const NAMES = [
  "Pre-releases are not published",
  "Release tag must equal v + a stable package.json version",
  "Release commit must already be on main",
  "Pack and verify tarball",
] as const;
const RELEASE = "github.event_name == 'release'";
const PRERELEASE = `${RELEASE} && github.event.release.prerelease`;
const ENTRIES = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/claudes.js",
  "package/package.json",
];
const SHA = "0123456789abcdef0123456789abcdef01234567";

// A GitHub Actions expression, e.g. `steps.pack.outputs.tarball`. It is built
// in a template literal because biome's noTemplateCurlyInString flags a plain
// string holding "${" (a mistyped template) and its noUnusedTemplateLiteral
// flags a template literal with no substitution — so the "$" sigil is a
// substitution of its own. The bytes compared are exactly what release.yml
// ships.
const DOLLAR = "$";
const expr = (body: string): string => `${DOLLAR}{{ ${body} }}`;

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function mapping(value: unknown): Mapping {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "mapping");
  return value as Mapping;
}

/** A step's identity in a failure message: its name, or what it runs. */
function label(step: Mapping): string {
  if (typeof step.name === "string") return step.name;
  return String(step.uses ?? step.run ?? "unnamed step");
}

function workflow(): Mapping {
  return mapping(YAML.parse(SOURCE));
}

function job(doc: Mapping, name: string): Mapping {
  return mapping(mapping(doc.jobs)[name]);
}

function steps(doc: Mapping): Mapping[] {
  const value = job(doc, "build").steps;
  requireThat(Array.isArray(value), "build steps missing");
  return value.map(mapping);
}

function guard(doc: Mapping, name: string): Mapping {
  const matches = steps(doc).filter((step) => step.name === name);
  requireThat(matches.length === 1, `missing or duplicate guard: ${name}`);
  return mapping(matches[0]);
}

/** Deliberately strict conditions: an unrecognised expression must not silently skip a guard. */
function active(step: Mapping, event: string, prerelease: boolean): boolean {
  if (step.if === undefined) return true;
  if (step.if === RELEASE) return event === "release";
  if (step.if === PRERELEASE) return event === "release" && prerelease;
  throw new Error(
    `disabled or unrecognised guard condition on step "${label(step)}": ${String(step.if)}`,
  );
}

function assertWiring(doc: Mapping): void {
  const build = job(doc, "build");
  const publish = job(doc, "publish");
  requireThat(doc.defaults === undefined && build.defaults === undefined, "shell defaults changed");
  requireThat(build.if === undefined, "build must not be conditional");
  requireThat(build["continue-on-error"] === undefined, "build must fail closed");
  requireThat(publish.needs === "build", "publish must depend on successful build");
  requireThat(publish.if === RELEASE, "publish must use the normal success condition");
  requireThat(publish["continue-on-error"] === undefined, "publish must fail closed");
  const all = steps(doc);
  for (const step of all) {
    requireThat(
      step["continue-on-error"] === undefined,
      `build step must fail closed: ${label(step)}`,
    );
    requireThat(
      step.shell === undefined || step.shell === "bash",
      `unexpected shell: ${label(step)}`,
    );
    const condition =
      step.name === NAMES[0]
        ? PRERELEASE
        : step.name === NAMES[1] || step.name === NAMES[2]
          ? RELEASE
          : undefined;
    requireThat(step.if === condition, `build step condition changed: ${label(step)}`);
  }
  const checkout = all.findIndex((step) => String(step.uses).startsWith("actions/checkout@"));
  requireThat(checkout >= 0, "checkout missing");
  requireThat(mapping(mapping(all[checkout]).with)["fetch-depth"] === 0, "full history required");
  const check = all.findIndex((step) => step.run === "bin/check");
  const upload = all.findIndex((step) => String(step.uses).startsWith("actions/upload-artifact@"));
  const positions = NAMES.map((name) => all.indexOf(guard(doc, name)));
  // map(mapping) preserves object identity; all guards must precede artifact upload.
  const [pre, tag, ancestry, pack] = positions;
  requireThat(
    pre !== undefined && tag !== undefined && ancestry !== undefined && pack !== undefined,
    "guard positions missing",
  );
  requireThat(
    checkout < pre &&
      pre < tag &&
      tag < ancestry &&
      ancestry < check &&
      check < pack &&
      pack < upload,
    "guards must run in order before upload and publish",
  );
  requireThat(guard(doc, NAMES[3]).id === "pack", "pack output id changed");
  requireThat(
    mapping(guard(doc, NAMES[1]).env).RELEASE_TAG === expr("github.event.release.tag_name"),
    "release tag must come from the event",
  );
  requireThat(
    mapping(build.outputs).tarball === expr("steps.pack.outputs.tarball"),
    "build must expose verified tarball",
  );
  requireThat(
    mapping(mapping(all[upload]).with).path === expr("steps.pack.outputs.tarball"),
    "upload must use verified tarball",
  );
}

interface Scenario {
  event?: string;
  prerelease?: boolean;
  version?: string;
  tag?: string;
  ancestor?: boolean;
  entries?: string[];
}

/** Only these four bodies run. Closed PATH stubs cannot publish, fetch, or touch real git. */
function execute(step: Mapping, scenario: Scenario = {}) {
  if (!active(step, scenario.event ?? "release", scenario.prerelease ?? false)) return null;
  requireThat(typeof step.run === "string" && step.run.trim() !== "", "guard body missing");
  const root = mkdtempSync(join(tmpdir(), "claudes-release-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["sort", "tail"]) {
      const real = Bun.which(tool);
      requireThat(real, `required local tool missing: ${tool}`);
      symlinkSync(real, join(bin, tool));
    }
    const scripts = {
      node: `
[ "$#" = 2 ] && [ "$1" = -p ] && [ "$2" = "require('./package.json').version" ] || exit 97
printf '%s\\n' "$FIXTURE_VERSION"
`,
      git: `
printf '%s\\n' "$@" > git.args
[ "$#" = 4 ] && [ "$1" = merge-base ] && [ "$2" = --is-ancestor ] &&
  [ "$3" = "$GITHUB_SHA" ] && [ "$4" = origin/main ] || exit 97
exit "$FIXTURE_ANCESTRY"
`,
      npm: `
[ "$#" = 1 ] && [ "$1" = pack ] || exit 97
printf 'pack\\n' > npm.args
printf 'fixture.tgz\\n'
`,
      tar: `
[ "$#" = 2 ] && [ "$1" = -tzf ] && [ "$2" = fixture.tgz ] || exit 97
printf '%s\\n' "$@" > tar.args
printf '%s\\n' "$FIXTURE_ENTRIES"
`,
    };
    for (const [name, script] of Object.entries(scripts)) {
      writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${script}`, { mode: 0o755 });
    }
    const result = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run],
      {
        cwd: root,
        env: {
          PATH: bin,
          HOME: root,
          LC_ALL: "C",
          RELEASE_TAG: scenario.tag ?? "v1.2.3",
          GITHUB_SHA: SHA,
          GITHUB_OUTPUT: join(root, "output"),
          FIXTURE_VERSION: scenario.version ?? "1.2.3",
          FIXTURE_ANCESTRY: scenario.ancestor === false ? "1" : "0",
          FIXTURE_ENTRIES: (scenario.entries ?? ENTRIES).join("\n"),
        },
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      },
    );
    requireThat(!result.error && result.signal === null, `guard spawn failed: ${result.error}`);
    if (step.name === NAMES[2]) {
      expect(readFileSync(join(root, "git.args"), "utf8")).toBe(
        `merge-base\n--is-ancestor\n${SHA}\norigin/main\n`,
      );
    }
    if (step.name === NAMES[3]) {
      expect(readFileSync(join(root, "npm.args"), "utf8")).toBe("pack\n");
      expect(readFileSync(join(root, "tar.args"), "utf8")).toBe("-tzf\nfixture.tgz\n");
      if (result.status === 0) {
        expect(readFileSync(join(root, "output"), "utf8")).toBe("tarball=fixture.tgz\n");
      }
    }
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verdict(step: Mapping, scenario: Scenario, diagnostic?: string): void {
  const result = execute(step, scenario);
  requireThat(result, "expected guard to run");
  expect(result.status).toBe(diagnostic ? 1 : 0);
  if (diagnostic) expect(result.stderr).toContain(`::error title=${diagnostic}::`);
  else expect(result.stderr).toBe("");
}

/** Shared contract used for both the shipped workflow and every in-memory mutation. */
function assertRelease(doc: Mapping): void {
  assertWiring(doc);
  const pre = guard(doc, NAMES[0]);
  expect(execute(pre)).toBeNull();
  expect(execute(pre, { event: "workflow_dispatch", prerelease: true })).toBeNull();
  verdict(pre, { prerelease: true }, "Pre-release refused");
  const tag = guard(doc, NAMES[1]);
  verdict(tag, {});
  verdict(tag, { tag: "v9.9.9" }, "Tag/version mismatch");
  verdict(tag, { version: "1.2.3-rc.1", tag: "v1.2.3-rc.1" }, "Pre-release version refused");
  const ancestry = guard(doc, NAMES[2]);
  verdict(ancestry, {});
  verdict(ancestry, { ancestor: false }, "Release not on main");
  for (const step of [tag, ancestry]) {
    expect(execute(step, { event: "workflow_dispatch" })).toBeNull();
  }
  const pack = guard(doc, NAMES[3]);
  verdict(pack, { entries: [...ENTRIES].reverse() });
  verdict(pack, { event: "workflow_dispatch" });
  for (let index = 0; index < ENTRIES.length; index++) {
    verdict(
      pack,
      { entries: ENTRIES.filter((_, i) => i !== index) },
      "Unexpected tarball contents",
    );
  }
  for (const extra of ["package/secret.txt", ENTRIES[0] ?? "", "package/"]) {
    verdict(pack, { entries: [...ENTRIES, extra] }, "Unexpected tarball contents");
  }
}

describe("shipped stable-release protections (no publication)", () => {
  test("active ordered guards reject bad fixtures and accept positive controls", () => {
    assertRelease(workflow());
  });

  for (const name of NAMES) {
    test(`removal, disablement and neutralized aborts fail the contract: ${name}`, () => {
      const removed = workflow();
      job(removed, "build").steps = steps(removed).filter((step) => step.name !== name);
      expect(() => assertRelease(removed)).toThrow(`missing or duplicate guard: ${name}`);
      const disabled = workflow();
      guard(disabled, name).if = false;
      expect(() => assertRelease(disabled)).toThrow(`build step condition changed: ${name}`);
      const softened = workflow();
      guard(softened, name)["continue-on-error"] = true;
      expect(() => assertRelease(softened)).toThrow(`build step must fail closed: ${name}`);
      const neutralized = workflow();
      const step = guard(neutralized, name);
      requireThat(typeof step.run === "string" && step.run.includes("exit 1"), "no abort found");
      step.run = step.run.replaceAll("exit 1", ":");
      expect(() => assertRelease(neutralized)).toThrow();
    });
  }

  test("package prerelease and tag equality are independently guarded", () => {
    for (const diagnostic of ["Pre-release version refused", "Tag/version mismatch"]) {
      const doc = workflow();
      const step = guard(doc, NAMES[1]);
      requireThat(typeof step.run === "string", "tag guard missing");
      step.run = step.run.replace(
        new RegExp(`(echo "::error title=${diagnostic}::[^\\n]+\\n\\s*)exit 1`),
        "$1:",
      );
      expect(() => assertRelease(doc)).toThrow();
    }
  });

  test("weakened comparison, ancestry, history, ordering and job wiring fail", () => {
    const mutations: ((doc: Mapping) => void)[] = [
      (doc) => {
        const step = guard(doc, NAMES[3]);
        step.run = String(step.run).replace('[ "$actual" != "$expected" ]', "false");
      },
      (doc) => {
        const step = guard(doc, NAMES[2]);
        step.run = String(step.run).replace(
          '"$GITHUB_SHA" origin/main',
          'origin/main "$GITHUB_SHA"',
        );
      },
      (doc) => {
        const checkout = steps(doc).find((step) =>
          String(step.uses).startsWith("actions/checkout@"),
        );
        mapping(mapping(checkout).with)["fetch-depth"] = 1;
      },
      (doc) => {
        job(doc, "build").steps = steps(doc).reverse();
      },
      (doc) => {
        job(doc, "build").if = false;
      },
      (doc) => {
        job(doc, "publish").needs = [];
      },
      (doc) => {
        job(doc, "publish").if = "always()";
      },
    ];
    for (const mutate of mutations) {
      const doc = workflow();
      mutate(doc);
      expect(() => assertRelease(doc)).toThrow();
    }
  });
});
