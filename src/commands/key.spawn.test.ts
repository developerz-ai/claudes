import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, configFile } from "../config/paths";
import { assertNoKeyFragment } from "../test-support/redact";

const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";
const MAIN = join(import.meta.dir, "../main.ts");
const SPAWN_TEST_TIMEOUT_MS = 30_000;

/** A scratch HOME holding a hand-written 0700 dir and 0600 config. */
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "claudes-keyspawn-"));
  const dir = configDir({ HOME: home });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = configFile(dir);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      baseUrl: "https://router.example.test",
      key: KEY,
      tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    }),
    "utf8",
  );
  chmodSync(path, 0o600);
  return home;
}

/** Single-quotes one word for the /bin/sh -c string `script -c` will run. */
function shQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The env every spawn in this file runs under: an explicit, closed object —
 * never process.env wholesale — so an ambient CLAUDE_CODE_USE_* (a remote
 * Claude Code session exports CLAUDE_CODE_USE_CCR_V2=1) or an ambient
 * ANTHROPIC_BASE_URL cannot make these key runs refuse for reasons the test
 * never chose.
 */
function childEnv(home: string): Record<string, string | undefined> {
  return { PATH: process.env.PATH, HOME: home, TERM: "dumb" };
}

/** `script` runs a command under a pseudo-tty; absent on some systems. */
const SCRIPT_AVAILABLE = spawnSync("sh", ["-c", "command -v script >/dev/null 2>&1"]).status === 0;

/**
 * How to run `claudes key` under a pseudo-tty on this platform: the util-linux
 * and BSD `script` variants take different arguments. util-linux needs
 * `-e` to propagate the child's exit code; BSD `script` returns the child's
 * exit status by default. Where neither form applies, the reason to skip.
 */
function ptyPlan(): { argv: string[] } | { skip: string } {
  if (process.platform === "linux") {
    return {
      argv: ["-qec", `${shQuote(process.execPath)} ${shQuote(MAIN)} key`, "/dev/null"],
    };
  }
  if (process.platform === "darwin") {
    return { argv: ["-q", "/dev/null", process.execPath, MAIN, "key"] };
  }
  return { skip: `no known \`script\` form for platform ${process.platform}` };
}

const PTY = ptyPlan();
const PTY_SKIP_REASON = !SCRIPT_AVAILABLE
  ? "`script` is not on PATH on this system"
  : "skip" in PTY
    ? PTY.skip
    : undefined;
if (PTY_SKIP_REASON !== undefined) {
  console.log(`skipping the pty test: ${PTY_SKIP_REASON}`);
}

describe("claudes key through a real process (bun src/main.ts key)", () => {
  test(
    "piped stdout: the exact key bytes, nothing else, exit 0",
    () => {
      const home = scratchHome();
      try {
        const res = spawnSync(process.execPath, [MAIN, "key"], {
          env: childEnv(home),
          encoding: "buffer",
          timeout: SPAWN_TEST_TIMEOUT_MS,
        });
        expect(res.error).toBeUndefined();
        expect(res.status).toBe(0);
        // Exact bytes: the key and no trailing newline.
        expect(res.stdout.equals(Buffer.from(KEY, "utf8"))).toBe(true);
        expect(res.stderr.length).toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a provider switch in the process env: exit 64, the refusal, no key bytes",
    () => {
      const home = scratchHome();
      try {
        const res = spawnSync(process.execPath, [MAIN, "key"], {
          env: { ...childEnv(home), CLAUDE_CODE_USE_BEDROCK: "1" },
          encoding: "buffer",
          timeout: SPAWN_TEST_TIMEOUT_MS,
        });
        expect(res.error).toBeUndefined();
        expect(res.status).toBe(64);
        const errText = res.stderr.toString("utf8");
        expect(errText).toBe(
          "claudes key: refusing: CLAUDE_CODE_USE_BEDROCK is set, so this session would not go to the router\n",
        );
        expect(res.stdout.length).toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test.skipIf(PTY_SKIP_REASON !== undefined)(
    "under a pseudo-tty (script): exit 64, no key bytes",
    () => {
      const home = scratchHome();
      try {
        if (!("argv" in PTY)) {
          throw new Error(`unreachable: the skipIf guard already skipped (${PTY.skip})`);
        }
        const res = spawnSync("script", PTY.argv, {
          env: childEnv(home),
          encoding: "buffer",
          timeout: SPAWN_TEST_TIMEOUT_MS,
        });
        const out = res.stdout.toString("utf8");
        if (res.status !== 64) {
          // Print the captured output to aid diagnosis. The leak assertions
          // below would fail the test first if it could contain the key, and
          // this assert makes that certain before anything is printed.
          assertNoKeyFragment(out, KEY);
          console.error(`pty run exited ${res.status}; captured output:\n${out}`);
        }
        expect(res.error).toBeUndefined();
        expect(res.status).toBe(64);
        expect(out).toContain("claudes key is for apiKeyHelper only");
        expect(out).not.toContain(KEY);
        assertNoKeyFragment(out, KEY);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
