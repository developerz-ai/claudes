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

/** `script` (util-linux) runs a command under a pseudo-tty; absent on some systems. */
const SCRIPT_AVAILABLE = spawnSync("sh", ["-c", "command -v script >/dev/null 2>&1"]).status === 0;

describe("claudes key through a real process (bun src/main.ts key)", () => {
  test(
    "piped stdout: the exact key bytes, nothing else, exit 0",
    () => {
      const home = scratchHome();
      try {
        const res = spawnSync(process.execPath, [MAIN, "key"], {
          env: { PATH: process.env.PATH, HOME: home },
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
          env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_USE_BEDROCK: "1" },
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

  test.skipIf(!SCRIPT_AVAILABLE)(
    "under a pseudo-tty (script -qec): exit 64, no key bytes",
    () => {
      const home = scratchHome();
      try {
        const res = spawnSync(
          "script",
          ["-qec", `${shQuote(process.execPath)} ${shQuote(MAIN)} key`, "/dev/null"],
          {
            env: { PATH: process.env.PATH, HOME: home, TERM: "dumb" },
            encoding: "buffer",
            timeout: SPAWN_TEST_TIMEOUT_MS,
          },
        );
        expect(res.error).toBeUndefined();
        expect(res.status).toBe(64);
        const out = res.stdout.toString("utf8");
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
