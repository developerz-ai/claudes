import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import type { Config } from "../config/schema";
import { KEY, ROUTER } from "../test-support/fixtures";
import type { RunProc } from "./run-proc";

/** Shared fixtures for the doctor test files; nothing here touches a network. */
export { KEY, ROUTER };
/** A second, wrong credential: what a competing source would hand to claude. */
export const FOREIGN_CREDENTIAL = "sk-ant-api03-someone-elses";

export const TIERS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
} as const;

export function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: ROUTER,
    key: KEY,
    tiers: { ...TIERS },
    ...overrides,
  };
}

/** A runProc whose stdout answers `claude --version`. */
export function versionProc(stdout: string, exitCode = 0): RunProc {
  return async () => ({
    // ProcResult.ok means "ran and exited" at ANY exit code (run-proc.ts), so
    // a non-zero exitCode still stands in for a successful spawn; judging the
    // code is the check's job.
    ok: true,
    code: exitCode,
    signal: null,
    timedOut: false,
    stdout,
  });
}

export interface FakeClaudeOptions {
  /**
   * The credential the fake claude presents; defaults to the configured key.
   * The wiring check only ever sees its hash, so this is the seam for "a
   * different credential arrived".
   */
  readonly credential?: string;
  /** The model the fake claude requests; defaults to the sonnet tier. */
  readonly model?: string;
  /**
   * Unlinks the --settings file before "running" and exits 1 without any
   * request — the race where the generated settings file is gone before
   * claude reads it.
   */
  readonly removeSettings?: boolean;
  /** The fake claude's exit code; defaults to 0. */
  readonly exitCode?: number;
  /** The fake's answer to `claude --version`; defaults to a healthy 2.1.300. */
  readonly version?: string;
}

/**
 * A fake `claude` for the wiring check: it plays only the part of the real
 * binary the check observes — read the --settings file the launcher's
 * buildArgv pinned, send one POST /v1/messages to the base URL the launcher's
 * buildSettings pinned, with the credential and model chosen above, through
 * the real generated env — and then exit. The POST goes to the check's real
 * recording stub on 127.0.0.1, so the whole recording path is exercised; no
 * real claude ever runs in a unit test.
 */
/** What the fake claude was invoked with, for env and argv assertions. */
export interface FakeClaudeCall {
  readonly command: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * A fake `claude` for the wiring check: it plays only the part of the real
 * binary the check observes — read the --settings file the launcher's
 * buildArgv pinned, send one POST /v1/messages to the base URL the launcher's
 * buildSettings pinned, with the credential and model chosen above, through
 * the real generated env — and then exit. The POST goes to the check's real
 * recording stub on 127.0.0.1, so the whole recording path is exercised; no
 * real claude ever runs in a unit test.
 */
export function fakeClaudeProc(options: FakeClaudeOptions = {}): {
  runProc: RunProc;
  calls: FakeClaudeCall[];
} {
  const calls: FakeClaudeCall[] = [];
  const runProc: RunProc = async (command, argv, procOptions) => {
    calls.push({ command, argv, env: procOptions.env ?? {} });
    const settingsAt = argv.indexOf("--settings");
    const settingsPath = settingsAt === -1 ? undefined : argv[settingsAt + 1];
    if (settingsPath === undefined) {
      // The runtime check's `claude --version` probe, not a wiring run —
      // options.exitCode applies here too, so a test can pin a failing probe.
      const code = options.exitCode ?? 0;
      return {
        ok: true, // ran and exited; the exit code is the check's to judge
        code,
        signal: null,
        timedOut: false,
        stdout: options.version ?? "2.1.300 (Claude Code)\n",
      };
    }
    let ran = false;
    if (options.removeSettings === true) {
      if (settingsPath !== undefined && existsSync(settingsPath)) {
        unlinkSync(settingsPath);
      }
    } else if (settingsPath !== undefined && existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        readonly env: Record<string, string>;
      };
      const base = settings.env.ANTHROPIC_BASE_URL;
      const model = options.model ?? TIERS.sonnet;
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.credential ?? KEY,
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          stream: false,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      ran = true;
    }
    const code = options.exitCode ?? (ran ? 0 : 1);
    return { ok: true, code, signal: null, timedOut: false, stdout: "" };
  };
  return { runProc, calls };
}

/** The mode and existence of a path, for asserting the probe's file hygiene. */
export function fileFacts(path: string): { exists: boolean; mode: number } {
  try {
    return { exists: true, mode: statSync(path).mode & 0o777 };
  } catch {
    return { exists: false, mode: 0 };
  }
}
