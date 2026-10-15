import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, configFile } from "../config/paths";
import type { Config } from "../config/schema";
import { writeConfig } from "../config/store";
import type { FetchLike } from "../router/client";
import { type Child, run, type SignalWiring, type SpawnFn } from "./run";

/** Shared fixtures for the run test files; the spawn seam is always a stub. */
export const ROUTER = "https://router.example.test";
export const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";
export const NODE = "/usr/local/bin/node";
export const SCRIPT = "/opt/claudes/bin/claudes.js";

/** A Child stand-in whose fate the test scripts from the outside. */
export class FakeChild extends EventEmitter implements Child {
  kills: (string | undefined)[] = [];

  kill(signal?: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

export function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: ROUTER,
    key: KEY,
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    ...overrides,
  };
}

export const healthyFetch: FetchLike = async () =>
  new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });

export const deadFetch: FetchLike = async () => {
  throw new TypeError("fetch failed");
};

/** The signal seam: handlers are captured, never wired to the real process. */
export function fakeWiring(): { wiring: SignalWiring; fired: Map<string, () => void> } {
  const fired = new Map<string, () => void>();
  const wiring: SignalWiring = {
    on: (signal, handler) => fired.set(signal, handler),
    off: (signal) => {
      fired.delete(signal);
    },
  };
  return { wiring, fired };
}

export interface SpawnCall {
  command: string;
  argv: readonly string[];
  env: Record<string, string | undefined>;
}

export interface Harness {
  home: string;
  dir: string;
  binDir: string;
  err: string[];
  spawnCalls: SpawnCall[];
  children: FakeChild[];
  drive(args: readonly string[], options?: DriveOptions): Promise<number>;
}

export interface DriveOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  wiring?: SignalWiring;
  /** Defaults to false: stdin is not a TTY, so SIGINT is forwarded. */
  stdinIsTTY?: boolean;
  spawnScript?: (child: FakeChild) => void;
}

/** A temp HOME with a valid config and an executable `claude` first on PATH. */
export function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "claudes-run-"));
  const dir = configDir({ HOME: home });
  // An executable `claude` at the front of PATH, so resolution succeeds; the
  // spawn seam intercepts before anything really runs.
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\n", "utf8");
  chmodSync(fakeClaude, 0o755);
  writeConfig(configFile(dir), sampleConfig());

  const err: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const children: FakeChild[] = [];

  const drive = async (args: readonly string[], options: DriveOptions = {}): Promise<number> => {
    const spawnFn: SpawnFn = (command, argv, spawnOptions) => {
      spawnCalls.push({ command, argv, env: spawnOptions.env ?? {} });
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => options.spawnScript?.(child));
      return child;
    };
    return await run(args, {
      env: options.env ?? { HOME: home, PATH: binDir, ANTHROPIC_AUTH_TOKEN: "sk-ant-personal" },
      fetch: options.fetch ?? healthyFetch,
      stderr: (text) => err.push(text),
      nodePath: NODE,
      scriptPath: SCRIPT,
      stdinIsTTY: options.stdinIsTTY ?? false,
      spawn: spawnFn,
      signals: options.wiring ?? fakeWiring().wiring,
    });
  };

  return { home, dir, binDir, err, spawnCalls, children, drive };
}

export function cleanup(h: Harness): void {
  rmSync(h.home, { recursive: true, force: true });
}
