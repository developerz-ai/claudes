import { type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ConfigError } from "../config/errors";
import { loadConfig } from "../config/load";
import { type Env, settingsFile } from "../config/paths";
import { writePrivateFile } from "../config/private-file";
import { errorName, type FetchLike, health, RouterError } from "../router/client";
import { buildArgv } from "./argv";
import { buildChildEnv } from "./env";
import { firstUnknownReroutingUseToggle } from "./provider-switches";
import { buildSettings } from "./settings";

export const ROUTER_UNREACHABLE_MESSAGE =
  "router unreachable: run `claudes doctor`, or use plain `claude` with your own login (usage won't be attributed)";
export const PROXY_NOTE_MESSAGE =
  "note: claudes' router check does not use HTTP(S)_PROXY; set NODE_USE_ENV_PROXY=1 if your network needs a proxy";
export const PREFLIGHT_TIMEOUT_NOTE_MESSAGE =
  "note: the router check timed out; set CLAUDES_PREFLIGHT_TIMEOUT_MS (milliseconds) to wait longer";
export const CLAUDE_NOT_FOUND_MESSAGE = "claude not found on PATH";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 1_500;
/** The largest accepted CLAUDES_PREFLIGHT_TIMEOUT_MS: a signed 32-bit integer. */
const MAX_PREFLIGHT_TIMEOUT_MS = 2_147_483_647;
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

/**
 * The router pre-flight timeout in milliseconds, from
 * `CLAUDES_PREFLIGHT_TIMEOUT_MS`; anything but an integer in 1..2147483647
 * (unset, empty, non-numeric, fractional, zero, negative, out of range) is
 * ignored in favor of the default.
 */
export function preflightTimeoutMs(env: Env): number {
  const raw = env.CLAUDES_PREFLIGHT_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_PREFLIGHT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PREFLIGHT_TIMEOUT_MS
    ? parsed
    : DEFAULT_PREFLIGHT_TIMEOUT_MS;
}

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
  /** Whether the parent's stdin is a TTY; a TTY means SIGINT reaches the child via the process group, so claudes must not also forward it. */
  readonly stdinIsTTY: boolean;
  readonly spawn?: SpawnFn;
  readonly signals?: SignalWiring;
}

/**
 * Runs `claude` against the router: load the config (or refuse), build the
 * child argv (or refuse), refuse an unknown rerouting toggle in the parent
 * env, pre-flight the router, write the generated settings atomically at 0600
 * in the 0700 config dir, then spawn `claude` with the stripped env, inherited
 * stdio, forwarded signals, and the child's exit code (or 128+n for a signal
 * death) as the answer. Never prints or passes the key.
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

  // A CLAUDE_CODE_USE_ toggle that is neither a known provider switch (those
  // are stripped from the child env and pinned to "" in the settings, so they
  // cannot reroute anything) nor a benign tool toggle would reach the child
  // unstripped — and `claudes key` would then refuse mid-session, stranding
  // the session at its first credential fetch. Refusing here, before any
  // network probe, names the variable instead.
  const unknownToggle = firstUnknownReroutingUseToggle(deps.env);
  if (unknownToggle !== undefined) {
    return fail(
      deps,
      64,
      `claudes: refusing: ${unknownToggle} is set, so this session would not go to the router`,
    );
  }

  try {
    await preflight(loaded.config.baseUrl, deps.fetch, preflightTimeoutMs(deps.env));
  } catch (err) {
    const timedOut = err instanceof RouterError && err.timedOut;
    return fail(deps, 69, ROUTER_UNREACHABLE_MESSAGE, [
      ...(proxyNoteNeeded(deps.env) ? [PROXY_NOTE_MESSAGE] : []),
      ...(timedOut ? [PREFLIGHT_TIMEOUT_NOTE_MESSAGE] : []),
    ]);
  }

  const settings = buildSettings(loaded.config, deps, deps.env);
  try {
    writePrivateFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      noun: "settings",
      remedy: 'remove it and re-run "claudes login"',
    });
  } catch (err) {
    return fail(deps, 1, settingsWriteError(err, settingsPath));
  }

  const claudePath = resolveExecutable("claude", deps.env);
  if (claudePath === undefined) {
    return fail(deps, 127, CLAUDE_NOT_FOUND_MESSAGE);
  }
  return await execClaude(claudePath, argv.argv, deps);
}

/**
 * One pre-flight attempt, retried exactly once when — and only when — the
 * router attempt timed out: a slow first probe (cold DNS, a just-woken
 * laptop) deserves a second chance, a hard refusal or connection error does
 * not. A second failure of any kind propagates.
 */
async function preflight(baseUrl: string, fetchImpl: FetchLike, timeoutMs: number): Promise<void> {
  try {
    await health(baseUrl, fetchImpl, timeoutMs);
  } catch (err) {
    if (!(err instanceof RouterError) || !err.timedOut) {
      throw err;
    }
    await health(baseUrl, fetchImpl, timeoutMs);
  }
}

/**
 * True when a proxy is set but Node's env-proxy opt-in is not: the pre-flight
 * would then bypass the developer's proxy and fail for that reason alone,
 * which deserves its own hint next to the unreachable message. Both cases of
 * each name count: tools export uppercase or lowercase, and ALL_PROXY covers
 * the scheme-agnostic form.
 */
function proxyNoteNeeded(env: Env): boolean {
  const proxySet = [
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.https_proxy,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ].some(isSet);
  return proxySet && !isSet(env.NODE_USE_ENV_PROXY);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * The reason a settings write failed, for the refusal message: a ConfigError
 * already carries a key-free, remedy-bearing message of its own; anything
 * else is named by its errno-shaped `code` when it has one.
 */
function settingsWriteError(err: unknown, settingsPath: string): string {
  if (err instanceof ConfigError) {
    return err.message;
  }
  return `claudes: could not write the settings file at ${settingsPath} (${errnoOf(err)})`;
}

/** The errno-shaped `err.code`, falling back to the error's class name. */
function errnoOf(err: unknown): string {
  try {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  } catch {
    // a throwing getter has no printable code
  }
  return errorName(err);
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
  // With stdin on a TTY, the terminal delivers SIGINT to the whole process
  // group — child included — so forwarding it would kill the child twice, and
  // claudes must still survive it: without any listener Node's default
  // disposition would kill claudes while the child is shutting down, losing
  // its exit code and orphaning it. So a TTY registers a NO-OP SIGINT handler
  // (the child got the terminal's copy already) and forwards the rest.
  // Without a TTY (pipes, nohup) nothing else delivers SIGINT, so claudes must.
  //
  // Known limitation of the no-op: a SIGINT addressed to the claudes PID only
  // (kill -INT <pid>, a supervisor) is swallowed rather than forwarded — the
  // handler cannot tell who sent the signal. Symmetrically, when stdin is
  // redirected but a controlling terminal remains, a Ctrl-C reaches the child
  // through the process group AND is forwarded by claudes: claude sees it
  // twice. Both edges are accepted over the alternative of killing the child
  // twice on every ordinary Ctrl-C.
  const forwarded = deps.stdinIsTTY
    ? FORWARDED_SIGNALS.filter((signal) => signal !== "SIGINT")
    : FORWARDED_SIGNALS;
  const forwards = forwarded.map((signal) => ({
    signal,
    handler: () => {
      child.kill(signal);
    },
  }));
  const held = deps.stdinIsTTY ? [{ signal: "SIGINT" as const, handler: () => {} }] : [];
  const wired = [...forwards, ...held];
  for (const { signal, handler } of wired) {
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
    for (const { signal, handler } of wired) {
      wiring.off(signal, handler);
    }
  }
}

/** Node's own signal-name → number table (SIGHUP 1, SIGINT 2, SIGTERM 15, …). */
function signalNumberOf(signal: NodeJS.Signals): number {
  const table = osConstants.signals as Record<string, number | undefined>;
  return table[signal] ?? 0;
}

/** Finds `name` on the env's PATH; only an executable regular file counts. */
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
      // A directory can carry the executable bit too; only a regular file is
      // something spawn can run, so a directory never wins the lookup.
      if (!statSync(candidate).isFile()) {
        continue;
      }
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not in this directory — keep walking the PATH
    }
  }
  return undefined;
}

/** Emits `message` then each note on its own line, and answers `code`. */
function fail(deps: RunDeps, code: number, message: string, notes: readonly string[] = []): number {
  let text = message.endsWith("\n") ? message : `${message}\n`;
  for (const note of notes) {
    text += `${note}\n`;
  }
  deps.stderr(text);
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
    stdinIsTTY: process.stdin.isTTY === true,
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
