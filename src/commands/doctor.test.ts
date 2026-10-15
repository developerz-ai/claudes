import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { configDir, configFile, type Env } from "../config/paths";
import { writeConfig } from "../config/store";
import type { PostFetch } from "../doctor/checks/live";
import { fakeClaudeProc, KEY, sampleConfig, TIERS, versionProc } from "../doctor/harness";
import type { FetchLike } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import { type DoctorDeps, runDoctor } from "./doctor";

const CLAUDE = "/usr/local/bin/claude";
const NODE = "/usr/local/bin/node";
const SCRIPT = "/opt/claudes/bin/claudes.js";
const IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];

const healthyRouter: FetchLike = async (url) => {
  if (url.endsWith("/healthz")) {
    return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
  }
  return new Response(JSON.stringify({ data: IDS.map((id) => ({ id })) }), { status: 200 });
};

interface Drive {
  readonly home: string;
  readonly env: Env;
}

/** A temp HOME whose XDG holds a real on-disk config with the fake key. */
function drive(): Drive {
  const home = mkdtempSync(join(tmpdir(), "doctor-cmd-"));
  const env: Env = { HOME: home, PATH: "/usr/bin" };
  writeConfig(configFile(configDir(env)), sampleConfig());
  return { home, env };
}

function deps(
  d: Drive,
  overrides: {
    readonly load?: DoctorDeps["load"];
    readonly runProc?: DoctorDeps["runProc"];
    readonly postFetch?: PostFetch;
    readonly readFile?: DoctorDeps["readFile"];
  } = {},
): { deps: DoctorDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const postFetch: PostFetch =
    overrides.postFetch ??
    (async () => new Response("{}", { status: 200, headers: { "x-request-id": "req-1" } }));
  return {
    out,
    err,
    deps: {
      env: d.env,
      platform: "linux",
      nodeVersion: "24.6.0",
      cwd: "/repo",
      nodePath: NODE,
      scriptPath: SCRIPT,
      fetch: healthyRouter,
      postFetch,
      runProc: overrides.runProc ?? versionProc("2.1.300 (Claude Code)\n"),
      resolveExecutable: () => CLAUDE,
      load: overrides.load ?? loadConfig,
      readFile: overrides.readFile ?? (() => undefined),
      mkdtemp: () => mkdtempSync(join(tmpdir(), "doctor-cmd-probe-")),
      rm: (path) => {
        rmSync(path, { recursive: true, force: true });
      },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
  };
}

describe("runDoctor", () => {
  test("a full healthy run prints every check and exits 0", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      const { deps: theDeps, out } = deps(d, { runProc: fake.runProc });
      const code = await runDoctor([], theDeps);
      expect(code).toBe(0);
      const text = out.join("");
      expect(text).toContain("[PASS] node 24.6.0");
      expect(text).toContain("[PASS] claude 2.1.300");
      expect(text).toContain("[PASS] config ");
      expect(text).toContain("mar_live_…");
      expect(text).toContain("[PASS] router https://router.example.test (version 1.4.2)");
      expect(text).toContain("[PASS] every pinned tier is served by the router");
      expect(text).toContain("[PASS] user, project and local settings set no conflicting keys");
      expect(text).toContain("[PASS] wiring probe: claude sent the router key to the stub");
      expect(text).toContain("[PASS] effective models:");
      expect(text).toContain(`model=${TIERS.sonnet}`);
      expect(text).not.toContain("[FAIL]");
      // The config path is the temp XDG one.
      expect(text).toContain(configFile(configDir(d.env)));
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("REDACTION: a full run with a known fake key never prints it", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      const { deps: theDeps, out, err } = deps(d, { runProc: fake.runProc });
      const code = await runDoctor([], theDeps);
      expect(code).toBe(0);
      const text = out.join("") + err.join("");
      expect(text).toContain("mar_live_…"); // the display prefix, as login prints it
      assertNoKeyFragment(text, KEY);
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("no config: exit 1, a FAIL line, and the dependent checks skipped", async () => {
    const d = drive();
    try {
      const { deps: theDeps, out } = deps(d, {
        load: () => ({
          ok: false,
          exitCode: 78,
          message: "no claudes config: run `claudes login --url <router>`",
        }),
      });
      const code = await runDoctor([], theDeps);
      expect(code).toBe(1);
      const text = out.join("");
      expect(text).toContain("[FAIL] config");
      expect(text).toContain("run `claudes login --url <router>`");
      expect(text).toContain("router, wiring and effective-model checks skipped");
      // The wiring probe never ran.
      expect(text).not.toContain("wiring probe: claude sent");
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("exit 1 when any check FAILs (here: an old claude)", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      const { deps: theDeps, out } = deps(d, { runProc: fake.runProc });
      const code = await runDoctor([], {
        ...theDeps,
        runProc: versionProc("2.0.0 (Claude Code)\n"),
      });
      expect(code).toBe(1);
      expect(out.join("")).toContain("[FAIL] claude 2.0.0");
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("a claude that exits non-zero from --version FAILs even with a version line", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc({ exitCode: 1 });
      const { deps: theDeps, out } = deps(d, { runProc: fake.runProc });
      const code = await runDoctor([], theDeps);
      expect(code).toBe(1);
      expect(out.join("")).toContain(`[FAIL] could not run ${CLAUDE} (exit 1)`);
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("--live adds exactly one live request line; without it there is none", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      let posts = 0;
      const postFetch: PostFetch = async () => {
        posts += 1;
        return new Response("{}", { status: 200, headers: { "x-request-id": "req-live-9" } });
      };
      const { deps: theDeps, out } = deps(d, { runProc: fake.runProc, postFetch });
      expect(await runDoctor([], theDeps)).toBe(0);
      expect(posts).toBe(0);
      expect(out.join("")).not.toContain("live request");
      expect(await runDoctor(["--live"], theDeps)).toBe(0);
      expect(posts).toBe(1);
      expect(out.join("")).toContain("[PASS] live request: POST /v1/messages answered HTTP 200");
      expect(out.join("")).toContain("request id req-live-9");
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("an unknown argument is a usage error: exit 64, nothing else runs", async () => {
    const d = drive();
    try {
      const { deps: theDeps, out, err } = deps(d);
      const code = await runDoctor(["--nonsense"], theDeps);
      expect(code).toBe(64);
      expect(err.join("")).toContain("unknown argument --nonsense");
      expect(err.join("")).toContain("usage: claudes doctor [--live]");
      expect(out.join("")).toBe("");
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("a managed-settings conflict FAILs the run", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      const { deps: theDeps, out } = deps(d, {
        runProc: fake.runProc,
        readFile: (path) =>
          path === "/etc/claude-code/managed-settings.json"
            ? JSON.stringify({ env: { ANTHROPIC_API_KEY: "managed" } })
            : undefined,
      });
      const code = await runDoctor([], theDeps);
      expect(code).toBe(1);
      expect(out.join("")).toContain(
        "[FAIL] managed settings /etc/claude-code/managed-settings.json",
      );
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

  test("a shell ANTHROPIC_* is INFO, not a failure", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      const { deps: theDeps, out } = deps(d, { runProc: fake.runProc });
      const code = await runDoctor([], {
        ...theDeps,
        env: { ...d.env, ANTHROPIC_API_KEY: "sk-ant-x" },
      });
      expect(code).toBe(0);
      expect(out.join("")).toContain("[INFO] ANTHROPIC_API_KEY is set in the shell");
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });
});
