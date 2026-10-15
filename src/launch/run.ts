import { type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadConfig } from "../config/load";
import { type Env, settingsFile } from "../config/paths";
import { writePrivateFile } from "../config/private-file";
import { errorName, type FetchLike, health } from "../router/client";
import { buildArgv } from "./argv";
import { buildChildEnv } from "./env";
import { buildSettings } from "./settings";

export const ROUTER_UNREACHABLE_MESSAGE =
  "router unreachable: run `claudes doctor`, or use plain `claude` with your own login (usage won't be attributed)";
export const CLAUDE_NOT_FOUND_MESSAGE = "claude not found on PATH";

const PREFLIGHT_TIMEOUT_MS = 1_500;
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

/** How run() subscribes to the signals it forwards; a seam for tests. */
export interface SignalWiring {
  readonly on: (signal: ForwardedSignal, handler: () => void) => void;
  readonly off: (signal: ForwardedSignal, handler: () => void) => void;
}

/** The slice of ChildProcess run() needs; an EventEmitter plus kill() is enough. */
export interface Child {
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): Child;
  on(event: "error", listener: (err: Error) => void): Child;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, argv: readonly string[], options: SpawnOptions) => Child;

export interface RunDeps {
  readonly env: Env;
  readonly fetch: FetchLike;
  readonly stderr: (text: string) => void;
  readonly nodePath: string;
  /** The absolute path of the running claudes script, for apiKeyHelper. */
  readonly scriptPath: string;
  readonly spawn?: SpawnFn;
  readonly signals?: SignalWiring;
}

/**
 * Runs `claude` against the router: load the config (or refuse), build the
 * child argv (or refuse), pre-flight the router, write the generated settings
 * atomically at 0600 in the 0700 config dir, then spawn `claude` with the
 * stripped env, inherited stdio, forwarded signals, and the child's exit code
 * (or 128+n for a signal death) as the answer. Never prints or passes the key.
 */
export async function run(userArgs: readonly string[], deps: RunDeps): Promise<number> {
  const loaded = loadConfig(deps.env);
  if (!loaded.ok) {
    return fail(deps, loaded.exitCode, loaded.message);
  }
  const settingsPath = settingsFile(loaded.dir);
  const argv = buildArgv(userArgs, settingsPath);
  if (!argv.ok) {
    return fail(deps, argv.exitCode, argv.message);
  }

  try {
    await health(loaded.config.baseUrl, deps.fetch, PREFLIGHT_TIMEOUT_MS);
  } catch {
    return fail(deps, 69, ROUTER_UNREACHABLE_MESSAGE);
  }

  const settings = buildSettings(loaded.config, deps);
  try {
    writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      noun: "settings",
      remedy: 'remove it and re-run "claudes login"',
    });
  } catch (err) {
    return fail(
      deps,
      1,
      `claudes: could not write the settings file at ${settingsPath} (${errorName(err)})`,
    );
  }

  const claudePath = resolveExecutable("claude", deps.env);
  if (claudePath === undefined) {
    return fail(deps, 127, CLAUDE_NOT_FOUND_MESSAGE);
  }
  return await execClaude(claudePath, argv.argv, deps);
}

async function execClaude(
  claudePath: string,
  argv: readonly string[],
  deps: RunDeps,
): Promise<number> {
  const spawnFn: SpawnFn =
    deps.spawn ?? ((command, args, options) => spawn(command, [...args], options) as Child);
  const child = spawnFn(claudePath, argv, { stdio: "inherit", env: buildChildEnv(deps.env) });
  const wiring = deps.signals ?? processSignals;
  const forwards = FORWARDED_SIGNALS.map((signal) => ({
    signal,
    handler: () => {
      child.kill(signal);
    },
  }));
  for (const { signal, handler } of forwards) {
    wiring.on(signal, handler);
  }
  try {
    return await new Promise<number>((resolve) => {
      child.on("exit", (code, signal) => {
        resolve(signal === null ? (code ?? 127) : 128 + signalNumberOf(signal));
      });
      child.on("error", (err) => {
        fail(deps, 127, `claudes: could not run ${claudePath} (${errorName(err)})`);
        resolve(127);
      });
    });
  } finally {
    for (const { signal, handler } of forwards) {
      wiring.off(signal, handler);
    }
  }
}

/** Node's own signal-name → number table (SIGHUP 1, SIGINT 2, SIGTERM 15, …). */
function signalNumberOf(signal: NodeJS.Signals): number {
  const table = osConstants.signals as Record<string, number | undefined>;
  return table[signal] ?? 0;
}

/** Finds `name` on the env's PATH; only a path we may execute counts. */
export function resolveExecutable(name: string, env: Env): string | undefined {
  const searchPath = env.PATH;
  if (searchPath === undefined || searchPath === "") {
    return undefined;
  }
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not in this directory — keep walking the PATH
    }
  }
  return undefined;
}

function fail(deps: RunDeps, code: number, message: string): number {
  deps.stderr(message.endsWith("\n") ? message : `${message}\n`);
  return code;
}

const processSignals: SignalWiring = {
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.removeListener(signal, handler),
};

/** Injectables for the real process; what main.ts passes to run(). */
export function realRunDeps(): RunDeps {
  return {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    stderr: (text) => process.stderr.write(text),
    nodePath: process.execPath,
    scriptPath: runningScriptPath(),
  };
}

/**
 * The absolute realpath of the running claudes script, so apiKeyHelper reaches
 * this exact install however it was symlinked onto PATH. A realpath failure
 * (exotic filesystem) falls back to the unresolved path rather than refusing
 * to launch.
 */
function runningScriptPath(): string {
  const entry = resolve(process.argv[1] ?? "claudes");
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}
