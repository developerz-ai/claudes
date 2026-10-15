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
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configDir, configFile, settingsFile } from "../config/paths";
import type { Config } from "../config/schema";
import { writeConfig } from "../config/store";
import type { FetchLike } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import { CLAUDE_NOT_FOUND_MESSAGE, ROUTER_UNREACHABLE_MESSAGE, run } from "./run";

const ROUTER = "https://router.example.test";
const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

/**
 * A real executable on PATH. It records its argv, the sorted names of its env,
 * and how many times the router key appears anywhere in argv or env values —
 * then exits with the code from FAKE_CLAUDE_EXIT, or waits to die by signal
 * when FAKE_CLAUDE_WAIT is set.
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
const record = { argv: process.argv, envNames: Object.keys(process.env).sort(), keyCount };
const out = process.env.FAKE_CLAUDE_OUT;
if (out !== undefined) fs.writeFileSync(out, JSON.stringify(record));
if (process.env.FAKE_CLAUDE_WAIT === "1") setInterval(() => {}, 500);
else process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
`;

interface ClaudeRecord {
  argv: string[];
  envNames: string[];
  keyCount: number;
}

let home: string;
let binDir: string;
let outFile: string;
let dir: string;
let err: string[];

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
  } = {},
): Promise<number> {
  const env = parentEnv(options.env ?? {});
  if (options.wait === true) {
    env.FAKE_CLAUDE_WAIT = "1";
  }
  return await run(args, {
    env,
    fetch: options.fetch ?? healthyFetch,
    stderr: (text) => err.push(text),
    nodePath: process.execPath,
    // A path with a space, so the e2e also exercises the helper quoting.
    scriptPath: join(home, "my claudes/claudes.js"),
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
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("run e2e: the happy path", () => {
  test("spawns the fake claude with the settings argv and a key-free env", async () => {
    const code = await drive(["--model", "claude-opus", "-p", "hello"]);
    expect(code).toBe(7); // FAKE_CLAUDE_EXIT passthrough
    const record = await readRecord();
    expect(record.argv.slice(2)).toEqual([
      "--settings",
      settingsFile(dir),
      "--model",
      "opus",
      "-p",
      "hello",
    ]);
    // The key appears nowhere: not in any argv element, not in any env value.
    expect(record.keyCount).toBe(0);
    // Personal credentials from the parent env are stripped by name.
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_ACCESS_KEY_ID",
    ]) {
      expect(record.envNames).not.toContain(name);
    }
    // The developer's environment survives.
    expect(record.envNames).toContain("EDITOR");
    expect(record.envNames).toContain("PATH");
    // claudes itself printed nothing.
    expect(err.join("")).toBe("");
    assertNoKeyFragment(err.join(""), KEY);
  });

  test("exit 0 passes through too", async () => {
    expect(await drive(["-p", "hi"], { env: { FAKE_CLAUDE_EXIT: "0" } })).toBe(0);
    await readRecord();
  });

  test("the settings file lands 0600 in the 0700 config dir, helper-quoted", async () => {
    await drive(["-p", "hi"]);
    await readRecord();
    const path = settingsFile(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.apiKeyHelper).toBe(
      `'${process.execPath}' '${join(home, "my claudes/claudes.js")}' key`,
    );
    assertNoKeyFragment(readFileSync(path, "utf8"), KEY);
  });
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
  test("a child killed outright (SIGKILL) exits 137", async () => {
    let killed: ChildProcess | undefined;
    const pending = run(["-p", "hi"], {
      env: parentEnv({ FAKE_CLAUDE_WAIT: "1" }),
      fetch: healthyFetch,
      stderr: (text) => err.push(text),
      nodePath: process.execPath,
      scriptPath: join(home, "my claudes/claudes.js"),
      spawn: (command, argv, options) => {
        killed = spawn(command, [...argv], options);
        return killed;
      },
    });
    await readRecord();
    killed?.kill("SIGKILL");
    expect(await pending).toBe(137);
  });

  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("a %s to claudes is forwarded and exits %d", async (signal, expected) => {
    const pending = drive(["-p", "hi"], { wait: true });
    await readRecord(); // the child is up, so the handlers are wired
    process.kill(process.pid, signal);
    expect(await pending).toBe(expected);
    expect(err.join("")).toBe("");
  });
});
