import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "../config/load";
import { configDir, configFile, type Env } from "../config/paths";
import { writeConfig } from "../config/store";
import type { PostFetch } from "../doctor/checks/live";
import { createProbeDir } from "../doctor/checks/wiring";
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
): { deps: DoctorDeps; out: string[]; err: string[]; probeDirs: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const probeDirs: string[] = [];
  const postFetch: PostFetch =
    overrides.postFetch ??
    (async () => new Response("{}", { status: 200, headers: { "x-request-id": "req-1" } }));
  return {
    out,
    err,
    probeDirs,
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
      // The probe's own tree, under the config dir — the seam only watches it.
      probeDir: (base) => {
        const dir = createProbeDir(base);
        probeDirs.push(dir);
        return dir;
      },
      rm: (path) => {
        rmSync(path, { recursive: true, force: true });
      },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
  };
}

function verboseFetchHarness(d: Drive, value: string | undefined) {
  const fake = fakeClaudeProc();
  const h = deps(d, { runProc: fake.runProc });
  const calls = { gets: 0, posts: 0, loads: 0, probes: 0, reads: 0, resolves: 0, probeDirs: 0 };
  const config = sampleConfig();
  const theDeps: DoctorDeps = {
    ...h.deps,
    env: { ...d.env, BUN_CONFIG_VERBOSE_FETCH: value },
    fetch: async (url, init) => {
      calls.gets += 1;
      if (url === `${config.baseUrl}/healthz`) {
        return healthyRouter(url, init);
      }
      expect(url).toBe(`${config.baseUrl}/v1/models`);
      expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
      return healthyRouter(url, init);
    },
    postFetch: async (url, init) => {
      calls.posts += 1;
      expect(url).toBe(`${config.baseUrl}/v1/messages`);
      expect(init.method).toBe("POST");
      expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
      return new Response("{}", { status: 200 });
    },
    load: (env) => {
      calls.loads += 1;
      return loadConfig(env);
    },
    runProc: (...args) => {
      calls.probes += 1;
      return fake.runProc(...args);
    },
    readFile: () => {
      calls.reads += 1;
      return undefined;
    },
    resolveExecutable: () => {
      calls.resolves += 1;
      return CLAUDE;
    },
    probeDir: (base) => {
      calls.probeDirs += 1;
      return createProbeDir(base);
    },
  };
  return { ...h, deps: theDeps, calls };
}

describe("runDoctor", () => {
  for (const argv of [[], ["--live"]]) {
    const mode = argv.length === 0 ? "doctor" : "doctor --live";
    const truthy = ["1", "true", "TRUE", "yes", " ", "doctor-secret-sentinel-94e2", KEY];
    for (const [index, value] of truthy.entries()) {
      test(`${mode} refuses verbose fetch truthy case ${index} before any checks`, async () => {
        const d = drive();
        try {
          const h = verboseFetchHarness(d, value);
          expect(await runDoctor(argv, h.deps)).toBe(64);
          expect(h.out.join("")).toBe("");
          const text = h.err.join("");
          expect(text).toBe(
            "claudes doctor: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed\n",
          );
          assertNoKeyFragment(text, KEY);
          if (value !== " ") {
            expect(text).not.toContain(value);
          }
          expect(h.calls).toEqual({
            gets: 0,
            posts: 0,
            loads: 0,
            probes: 0,
            reads: 0,
            resolves: 0,
            probeDirs: 0,
          });
        } finally {
          rmSync(d.home, { recursive: true, force: true });
        }
      });
    }

    for (const [index, value] of [undefined, "", "0", "false", "FALSE", "False"].entries()) {
      test(`${mode} allows verbose fetch falsy case ${index} with authenticated requests`, async () => {
        const d = drive();
        try {
          const h = verboseFetchHarness(d, value);
          expect(await runDoctor(argv, h.deps)).toBe(0);
          expect(h.calls.gets).toBe(2);
          expect(h.calls.posts).toBe(argv.length === 0 ? 0 : 1);
          expect(h.calls.loads).toBe(1);
          expect(h.calls.probes).toBe(2);
          expect(h.err.join("")).toBe("");
          expect(h.out.join("")).toContain("[PASS] wiring probe");
          assertNoKeyFragment(h.out.join("") + h.err.join(""), KEY);
        } finally {
          rmSync(d.home, { recursive: true, force: true });
        }
      });
    }
  }

  test("argument errors take precedence over verbose-fetch refusal", async () => {
    const d = drive();
    try {
      const h = verboseFetchHarness(d, KEY);
      expect(await runDoctor(["--nonsense"], h.deps)).toBe(64);
      expect(h.out.join("")).toBe("");
      expect(h.err.join("")).toBe(
        "claudes doctor: unknown argument #1\nusage: claudes doctor [--live]\n",
      );
      assertNoKeyFragment(h.err.join(""), KEY);
      expect(h.calls).toEqual({
        gets: 0,
        posts: 0,
        loads: 0,
        probes: 0,
        reads: 0,
        resolves: 0,
        probeDirs: 0,
      });
    } finally {
      rmSync(d.home, { recursive: true, force: true });
    }
  });

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

  test("the wiring probe's tree is created under the config dir and is gone when the run ends", async () => {
    const d = drive();
    try {
      const fake = fakeClaudeProc();
      const { deps: theDeps, out, probeDirs } = deps(d, { runProc: fake.runProc });
      expect(await runDoctor([], theDeps)).toBe(0);
      expect(probeDirs.length).toBe(1);
      const probeDir = probeDirs[0] as string;
      // Under the config directory the user config lives in — not a tree of
      // the OS temp directory, which the documented uninstall never reaches.
      expect(dirname(probeDir)).toBe(configDir(d.env));
      expect(basename(probeDir)).toMatch(/^probe\.\d+$/);
      // The key's only disk copy lived inside that tree, and it is gone with it.
      const wiring = fake.calls.find((call) => call.argv.includes("--settings"));
      const xdg = wiring?.env.XDG_CONFIG_HOME as string;
      expect(xdg).toBe(join(probeDir, "xdg"));
      expect(existsSync(join(xdg, "claudes", "config.json"))).toBe(false);
      expect(existsSync(probeDir)).toBe(false);
      assertNoKeyFragment(out.join(""), KEY);
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

  const rejectedArgs = [
    "--nonsense",
    "doctor-sensitive-sentinel-7d39",
    KEY,
    KEY.slice(9, 25),
    "--token=doctor-sensitive-sentinel-7d39",
    `--token=${KEY}`,
    "doctor-escape-\u001b[31m-sentinel",
    "doctor-osc-\u001b]0;sentinel\u0007",
    "doctor-return-\r-sentinel",
    "doctor-newline-\n-sentinel",
    "doctor-tab-\t-sentinel",
    "doctor-backspace-\b-sentinel",
    "doctor-delete-\u007f-sentinel",
    "doctor-null-\0-sentinel",
  ];
  for (const prefix of [[], ["--live"]]) {
    for (const [index, value] of rejectedArgs.entries()) {
      test(`unknown argument case ${index} at position ${prefix.length + 1} stops all checks`, async () => {
        const d = drive();
        try {
          const h = verboseFetchHarness(d, undefined);
          expect(await runDoctor([...prefix, value, "--also-invalid"], h.deps)).toBe(64);
          expect(h.out.join("")).toBe("");
          const text = h.err.join("");
          expect(text).toBe(
            `claudes doctor: unknown argument #${prefix.length + 1}\nusage: claudes doctor [--live]\n`,
          );
          expect(text).not.toContain(value);
          for (const byte of [0, 7, 8, 9, 13, 27, 127]) {
            expect(text).not.toContain(String.fromCharCode(byte));
          }
          assertNoKeyFragment(text + h.out.join(""), KEY);
          expect(h.calls).toEqual({
            gets: 0,
            posts: 0,
            loads: 0,
            probes: 0,
            reads: 0,
            resolves: 0,
            probeDirs: 0,
          });
        } finally {
          rmSync(d.home, { recursive: true, force: true });
        }
      });
    }
  }

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
