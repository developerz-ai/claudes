import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configDir, configFile, settingsFile } from "../config/paths";
import type { Config } from "../config/schema";
import { writeConfig } from "../config/store";
import type { FetchLike } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import { ROUTER_UNREACHABLE_MESSAGE } from "./preflight";
import { type Child, CLAUDE_NOT_FOUND_MESSAGE, run, type SignalWiring, type SpawnFn } from "./run";

const ROUTER = "https://router.example.test";
const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";
/** Explicit timeout for every test that spawns a child; the default is too tight under load. */
const SPAWN_TEST_TIMEOUT_MS = 30_000;

/**
 * A real executable on PATH. It records its argv, the sorted names of its env,
 * how many times the router key appears anywhere in argv or env values, how
 * many SIGINTs it received, and what its --settings file looked like while it
 * ran (existence, mode, contents) — the file outlives both this process and
 * the launcher, until a later launch sweeps it. It exits with the code from
 * FAKE_CLAUDE_EXIT, waits to die by signal when FAKE_CLAUDE_WAIT is set, or,
 * when FAKE_CLAUDE_TRAP_SIGINT is set, traps SIGINT like the real claude under
 * Ctrl-C: ~300ms of shutdown work, then exit 7. The record is written to a
 * temp file and renamed into place, so a reader never sees a half-written
 * JSON file.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const KEY = ${JSON.stringify(KEY)};
let keyCount = 0;
for (const arg of process.argv) {
  if (arg.includes(KEY)) keyCount++;
}
for (const value of Object.values(process.env)) {
  let at = value.indexOf(KEY);
  while (at !== -1) {
    keyCount++;
    at = value.indexOf(KEY, at + KEY.length);
  }
}
let settings = null;
const settingsAt = process.argv.indexOf("--settings");
if (settingsAt !== -1) {
  const path = process.argv[settingsAt + 1];
  try {
    const st = fs.statSync(path);
    settings = { exists: true, mode: st.mode & 0o777, text: fs.readFileSync(path, "utf8") };
  } catch {
    settings = { exists: false };
  }
}
let sigints = 0;
let exitedAt = 0;
function dump() {
  const out = process.env.FAKE_CLAUDE_OUT;
  if (out === undefined) return;
  const record = {
    argv: process.argv,
    envNames: Object.keys(process.env).sort(),
    keyCount,
    settings,
    sigints,
    exitedAt,
  };
  const tmp = \`\${out}.tmp\`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, out);
}
function exit7() {
  exitedAt = Date.now();
  dump();
  process.exit(7);
}
const trapping = process.env.FAKE_CLAUDE_TRAP_SIGINT === "1";
if (trapping) {
  let timer = null;
  process.on("SIGINT", () => {
    sigints += 1;
    dump();
    if (timer === null) timer = setTimeout(exit7, 300);
  });
  setTimeout(exit7, 10000);
}
// Written only once the trap above is armed, so a reader that sees the record
// can safely signal the child: before the arming, a SIGINT would kill it with
// the default disposition instead of the trapped shutdown path.
dump();
if (!trapping) {
  if (process.env.FAKE_CLAUDE_WAIT === "1") {
    setInterval(() => {}, 500);
    // A hard stop, unref'd so it never keeps a healthy process alive: if the
    // launcher dies without delivering the signal this process waits for, it
    // must not linger on the test machine forever.
    setTimeout(() => process.exit(99), 60_000).unref();
  } else process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
}
`;

interface ClaudeSettingsRecord {
  readonly exists: boolean;
  readonly mode?: number;
  readonly text?: string;
}

interface ClaudeRecord {
  argv: string[];
  envNames: string[];
  keyCount: number;
  settings: ClaudeSettingsRecord;
  sigints: number;
  exitedAt: number;
}

let home: string;
let binDir: string;
let outFile: string;
let dir: string;
let err: string[];
/** Every child this file spawned, so afterEach can kill any survivor by PID. */
let children: ChildProcess[];

const healthyFetch: FetchLike = async () =>
  new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });

const deadFetch: FetchLike = async () => {
  throw new TypeError("fetch failed");
};

function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: ROUTER,
    key: KEY,
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    ...overrides,
  };
}

/** The parent env a developer might have: personal creds that must not leak. */
function parentEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    HOME: home,
    // binDir first so the fake wins the `claude` lookup; the real PATH stays
    // so the fake's `#!/usr/bin/env node` shebang resolves node.
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_CLAUDE_OUT: outFile,
    FAKE_CLAUDE_EXIT: "7",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-oauth01-personal",
    ANTHROPIC_API_KEY: "sk-ant-api03-personal",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-ai-personal",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_ACCESS_KEY_ID: "AKIAPERSONAL",
    EDITOR: "vim",
    TERM: "dumb",
    ...overrides,
  };
}

async function drive(
  args: readonly string[],
  options: {
    env?: Record<string, string | undefined>;
    fetch?: FetchLike;
    wait?: boolean;
    trapSigint?: boolean;
    wiring?: SignalWiring;
    stdinIsTTY?: boolean;
  } = {},
): Promise<number> {
  const env = parentEnv(options.env ?? {});
  if (options.wait === true) {
    env.FAKE_CLAUDE_WAIT = "1";
  }
  if (options.trapSigint === true) {
    env.FAKE_CLAUDE_TRAP_SIGINT = "1";
  }
  // Wrap the spawn so every child is remembered for afterEach cleanup.
  const spawnFn: SpawnFn = (command, argv, spawnOptions) => {
    const child = spawn(command, [...argv], spawnOptions);
    children.push(child);
    return child as Child;
  };
  return await run(args, {
    env,
    fetch: options.fetch ?? healthyFetch,
    stderr: (text) => err.push(text),
    nodePath: process.execPath,
    // A path with a space, so the e2e also exercises the helper quoting.
    scriptPath: join(home, "my claudes/claudes.js"),
    stdinIsTTY: options.stdinIsTTY ?? false,
    spawn: spawnFn,
    signals: options.wiring,
  });
}

async function readRecord(timeoutMs = 10_000): Promise<ClaudeRecord> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(outFile)) {
    if (Date.now() > deadline) {
      throw new Error("the fake claude never wrote its record");
    }
    await Bun.sleep(20);
  }
  return JSON.parse(readFileSync(outFile, "utf8")) as ClaudeRecord;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-e2e-"));
  binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "claude");
  writeFileSync(fake, FAKE_CLAUDE, "utf8");
  chmodSync(fake, 0o755);
  outFile = join(home, "record.json");
  dir = configDir({ HOME: home });
  writeConfig(configFile(dir), sampleConfig());
  err = [];
  children = [];
});

afterEach(() => {
  // Kill any leftover fake child by PID — never a process-wide pkill — so one
  // test's survivor cannot eat another test's signals.
  for (const child of children) {
    try {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // the child exited between the check and the kill
    }
  }
  children = [];
  rmSync(home, { recursive: true, force: true });
});

describe("run e2e: the happy path", () => {
  test(
    "spawns the fake claude with the settings argv and a key-free env",
    async () => {
      const code = await drive(["--model", "claude-opus", "-p", "hello"]);
      expect(code).toBe(7); // FAKE_CLAUDE_EXIT passthrough
      const record = await readRecord();
      expect(record.argv.slice(2)).toEqual([
        "--settings",
        settingsFile(dir, process.pid),
        "--model",
        "opus",
        "-p",
        "hello",
      ]);
      // The key appears nowhere: not in any argv element, not in any env value.
      expect(record.keyCount).toBe(0);
      // Router-relevant credentials from the parent env are stripped by name.
      for (const name of [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
      ]) {
        expect(record.envNames).not.toContain(name);
      }
      // The developer's AWS credentials are inert without a switch: they survive.
      expect(record.envNames).toContain("AWS_ACCESS_KEY_ID");
      // The developer's environment survives.
      expect(record.envNames).toContain("EDITOR");
      expect(record.envNames).toContain("PATH");
      // claudes itself printed nothing.
      expect(err.join("")).toBe("");
      assertNoKeyFragment(err.join(""), KEY);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "exit 0 passes through too",
    async () => {
      expect(await drive(["-p", "hi"], { env: { FAKE_CLAUDE_EXIT: "0" } })).toBe(0);
      await readRecord();
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "the settings file lands 0600 in the 0700 config dir, helper-quoted",
    async () => {
      await drive(["-p", "hi"]);
      const record = await readRecord();
      expect(record.settings.exists).toBe(true);
      expect(record.settings.mode).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const settings = JSON.parse(record.settings.text as string);
      expect(settings.apiKeyHelper).toBe(
        `'${process.execPath}' '${join(home, "my claudes/claudes.js")}' key`,
      );
      assertNoKeyFragment(record.settings.text as string, KEY);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "the settings file exists while claude runs, outlives the launcher, and is swept by a later launch",
    async () => {
      // Launch 1 runs in a REAL launcher process, so its pid can die while
      // its settings file lives — the lifetime the sweep is keyed on. The
      // script drives the same run() this file imports, with only the fetch
      // seam stubbed (the router is synthetic).
      const launcherScript = join(home, "launcher.mjs");
      const runModule = pathToFileURL(join(import.meta.dir, "run.ts")).href;
      writeFileSync(
        launcherScript,
        [
          `import { run, realRunDeps } from ${JSON.stringify(runModule)};`,
          'const healthy = async () => new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });',
          "process.exit(await run(process.argv.slice(2), { ...realRunDeps(), fetch: healthy }));",
        ].join("\n"),
        "utf8",
      );
      const launcher = spawn(process.execPath, [launcherScript, "-p", "hi"], {
        env: parentEnv({ FAKE_CLAUDE_WAIT: "1" }),
        stdio: "ignore",
      });
      children.push(launcher);
      const record = await readRecord();
      const stranded = settingsFile(dir, launcher.pid as number);
      // While the child runs, its --settings file is on disk under 0600…
      expect(record.settings.exists).toBe(true);
      expect(statSync(stranded).mode & 0o777).toBe(0o600);
      // …SIGTERM reaches the launcher, which forwards it and answers 143…
      const exited = new Promise<number>((resolve) => {
        launcher.on("exit", (code, signal) => resolve(signal === null ? (code ?? 127) : 128));
      });
      launcher.kill("SIGTERM");
      expect(await exited).toBe(143);
      // …but the launcher does NOT remove the file on its way out: Claude
      // Code hands the --settings path to processes it starts later.
      expect(existsSync(stranded)).toBe(true);
      // A second launch — after the first launcher's pid is dead — sweeps it.
      expect(await drive(["-p", "hi"])).toBe(7);
      expect(existsSync(stranded)).toBe(false);
      // The second launch's own file outlives it too: its pid (this test
      // process's) is alive, so its own sweep never touches it.
      expect(existsSync(settingsFile(dir, process.pid))).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("run e2e: refusals before exec", () => {
  test("no config: exit 78, the exact message, and claude never runs", async () => {
    rmSync(configFile(dir));
    const code = await drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(err.join("")).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
    expect(existsSync(outFile)).toBe(false);
  });

  test("a config with a base URL but no credential: exit 78, never exec'd", async () => {
    rmSync(configFile(dir));
    const path = configFile(dir);
    writeFileSync(path, JSON.stringify({ ...sampleConfig(), key: undefined }), "utf8");
    chmodSync(path, 0o600);
    expect(await drive(["-p", "hi"])).toBe(78);
    expect(err.join("")).toContain("not a valid claudes config");
    expect(existsSync(outFile)).toBe(false);
  });

  test("insecure config perms: exit 78, never exec'd", async () => {
    chmodSync(configFile(dir), 0o644);
    expect(await drive(["-p", "hi"])).toBe(78);
    expect(err.join("")).toContain("readable by group or other users");
    expect(existsSync(outFile)).toBe(false);
  });

  for (const args of [
    ["--settings", "/tmp/mine.json"],
    ["--key", "k"],
    ["-p", KEY],
  ] as const) {
    test(`refused argv ${JSON.stringify(args)}: exit 64, no fetch, never exec'd`, async () => {
      const code = await drive(args, { fetch: deadFetch });
      expect(code).toBe(64);
      expect(err.join("")).not.toContain(KEY);
      expect(err.join("")).not.toContain("/tmp/mine.json");
      expect(existsSync(outFile)).toBe(false);
    });
  }

  test("an unreachable router: exit 69, the exact message, never exec'd", async () => {
    const code = await drive(["-p", "hi"], { fetch: deadFetch });
    expect(code).toBe(69);
    expect(err.join("")).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
    expect(existsSync(outFile)).toBe(false);
  });

  test("claude missing from PATH: exit 127, the message", async () => {
    const code = await drive(["-p", "hi"], { env: { PATH: "/nonexistent" } });
    expect(code).toBe(127);
    expect(err.join("")).toBe(`${CLAUDE_NOT_FOUND_MESSAGE}\n`);
    expect(existsSync(outFile)).toBe(false);
  });
});

describe("run e2e: signal deaths and forwarding", () => {
  test(
    "a child killed outright (SIGKILL) exits 137",
    async () => {
      const pending = drive(["-p", "hi"], { wait: true });
      await readRecord();
      children[children.length - 1]?.kill("SIGKILL");
      expect(await pending).toBe(137);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  // The signal is driven through the injected wiring, never by signalling this
  // test process itself.
  function captureWiring(): { wiring: SignalWiring; fired: Map<string, () => void> } {
    const fired = new Map<string, () => void>();
    const wiring: SignalWiring = {
      on: (signal, handler) => fired.set(signal, handler),
      off: (signal) => fired.delete(signal),
    };
    return { wiring, fired };
  }

  for (const [signal, expected] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(
      `a ${signal} to claudes is forwarded and exits ${expected}`,
      async () => {
        const { wiring, fired } = captureWiring();
        const pending = drive(["-p", "hi"], { wait: true, wiring });
        await readRecord(); // the child is up, so the handlers are wired
        fired.get(signal)?.();
        expect(await pending).toBe(expected);
        expect(err.join("")).toBe("");
      },
      SPAWN_TEST_TIMEOUT_MS,
    );
  }

  test(
    "stdin a TTY: SIGINT is wired as a no-op, SIGTERM still forwards",
    async () => {
      const { wiring, fired } = captureWiring();
      const pending = drive(["-p", "hi"], { wait: true, wiring, stdinIsTTY: true });
      await readRecord();
      expect(fired.has("SIGINT")).toBe(true);
      expect(fired.has("SIGTERM")).toBe(true);
      fired.get("SIGTERM")?.();
      expect(await pending).toBe(143);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "stdin a TTY: Ctrl-C waits for the child shutdown and keeps its exit code",
    async () => {
      const { wiring, fired } = captureWiring();
      let settled = false;
      let settledAt = 0;
      const pending = drive(["-p", "hi"], { wiring, stdinIsTTY: true, trapSigint: true });
      void pending.then(() => {
        settled = true;
        settledAt = Date.now();
      });
      await readRecord(); // the child is up, so the handlers are wired
      expect(fired.has("SIGINT")).toBe(true); // the no-op listener is registered
      const child = children[children.length - 1];
      expect(child?.pid).toBeDefined();
      // A real Ctrl-C hits the whole process group: the child gets its own
      // copy from the terminal…
      process.kill(child?.pid as number, "SIGINT");
      // …separated by a beat (the runtime coalesces same-signal hits in one
      // tick, which would hide a wrongly forwarded second copy)…
      await Bun.sleep(50);
      // …while claudes' own handler must be the no-op, never a forward.
      fired.get("SIGINT")?.();
      await Bun.sleep(20); // a beat: the handler itself resolves nothing
      expect(settled).toBe(false); // the child still has ~200ms of shutdown
      expect(await pending).toBe(7); // the child's exit code, not 130
      const record = await readRecord();
      expect(record.sigints).toBe(1); // exactly the terminal's copy: no forward
      // The promise settled only at or after the child's own exit, never on
      // the signal — the same clock stamps both sides.
      expect(record.exitedAt).toBeGreaterThan(0);
      expect(settledAt).toBeGreaterThanOrEqual(record.exitedAt);
      expect(err.join("")).toBe("");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
