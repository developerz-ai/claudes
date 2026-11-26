import { type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadConfig } from "../config/load";
import type { Env } from "../config/paths";
import { keyFragmentOffset } from "../config/schema";
import { type FetchLike, RouterError } from "../router/client";
import { errorName } from "../router/errors";
import { buildArgv, hasRouterKey, refusedKey } from "./argv";
import { resolveCatalog } from "./catalog";
import { buildChildEnv } from "./env";
import {
  PREFLIGHT_TIMEOUT_NOTE_MESSAGE,
  PROXY_NOTE_MESSAGE,
  preflightCatalog,
  preflightTimeoutMs,
  proxyNoteNeeded,
  ROUTER_INVALID_VERSION_MESSAGE,
  ROUTER_UNREACHABLE_MESSAGE,
  tlsVerifyNote,
} from "./preflight";
import {
  firstHostManagedEnv,
  firstUnknownReroutingUseToggle,
  isTruthyToggle,
} from "./provider-switches";
import { explicitModel, readSavedModel, sessionModel } from "./session-model";
import { buildSettings } from "./settings";
import {
  launchSettingsPath,
  settingsWriteError,
  sweepStaleLaunchSettings,
  writeLaunchSettings,
} from "./settings-file";

import { classify, offRouterOption } from "./subcommands";

export const CLAUDE_NOT_FOUND_MESSAGE = "claude not found on PATH";
export const CLAUDE_INSTALL_HINT =
  "claudes wraps Claude Code. Install Claude Code separately and make it available on PATH.";
export const SELF_REFERENCE_MESSAGE = "claudes: the claude on PATH is claudes itself";

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
  readonly profile?: string;
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
 * Runs Claude Code management commands directly and routes sessions through
 * the configured router. For a routed session, load the config, build the
 * child argv (or refuse), refuse an env that would reroute the session or
 * print the key, sweep stale temporary files (before any
 * network probe, so it also runs when the router is down), pre-flight the
 * router, write this launch's settings atomically at 0600 in the 0700 config
 * dir under a per-launch name, then spawn `claude` with the stripped env,
 * inherited stdio, forwarded signals, and the child's exit code (or 128+n for
 * a signal death) as the answer. The settings file is left in place when this
 * launcher exits — Claude Code hands its --settings path to processes it
 * starts later (/restart, --tmux, background agents), which may read it after
 * this process is gone.
 * Never prints or passes the key.
 */
export async function run(userArgs: readonly string[], deps: RunDeps): Promise<number> {
  if (hasRouterKey(userArgs)) {
    const refusal = refusedKey();
    return fail(deps, refusal.exitCode, refusal.message);
  }

  const offRouter = offRouterOption(userArgs);
  if (offRouter !== undefined) {
    return fail(deps, 64, `claudes: ${offRouter} is not supported — it runs outside the router`);
  }
  const launchClass = classify(userArgs);
  if (launchClass === "manage") {
    const claude = resolveClaude(deps);
    return typeof claude === "number" ? claude : await execClaude(claude, userArgs, deps);
  }

  const loaded = loadConfig(deps.env, deps.profile);
  if (!loaded.ok) {
    return fail(deps, loaded.exitCode, loaded.message);
  }
  const argv = buildArgv(userArgs, "", launchClass);
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
    return refuseReroute(deps, unknownToggle);
  }

  // A host that manages Claude Code's provider/auth env makes it ignore the
  // generated settings file outright: the session would silently skip the
  // router while appearing to work, so it is refused the same way, by name.
  const hostManaged = firstHostManagedEnv(deps.env);
  if (hostManaged !== undefined) {
    return refuseReroute(deps, hostManaged);
  }

  // Bun's verbose fetch prints every request — headers included — so a truthy
  // value would print the router key to stderr. The settings pin below covers
  // a settings-file plant; a truthy parent shell is refused before any probe.
  if (isTruthyToggle(deps.env.BUN_CONFIG_VERBOSE_FETCH)) {
    return fail(
      deps,
      64,
      "claudes: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed",
    );
  }

  // The sweep touches no network, so it runs before the router pre-flight:
  // a stranded file is cleaned up even when the router is down and this
  // launch never reaches its own write.
  sweepStaleLaunchSettings(loaded.dir);

  let probe: Awaited<ReturnType<typeof preflightCatalog>>;
  try {
    probe = await preflightCatalog(loaded.config, deps.fetch, preflightTimeoutMs(deps.env));
  } catch (err) {
    const routerError = err instanceof RouterError ? err : undefined;
    if (routerError?.invalidVersion === true) {
      // The router answered the check but reported no usable version: a
      // different refusal from an unreachable router, and the proxy, TLS and
      // timeout notes do not apply — the probe answered.
      return fail(deps, 69, ROUTER_INVALID_VERSION_MESSAGE);
    }
    if (routerError?.status !== undefined) {
      return fail(
        deps,
        69,
        `router health check returned HTTP ${routerError.status}: run \`claudes doctor\``,
      );
    }
    const tlsNote = tlsVerifyNote(routerError?.tlsVerifyCode);
    return fail(deps, 69, ROUTER_UNREACHABLE_MESSAGE, [
      ...(proxyNoteNeeded(deps.env) ? [PROXY_NOTE_MESSAGE] : []),
      ...(tlsNote !== undefined ? [tlsNote] : []),
      ...(routerError?.timedOut === true ? [PREFLIGHT_TIMEOUT_NOTE_MESSAGE] : []),
    ]);
  }

  const profile = loaded.profile ?? "default";
  if (probe.rejected) {
    const remedy = `claudes login --profile ${profile}`;
    return fail(
      deps,
      77,
      keyFragmentOffset(remedy, loaded.config.key) === undefined
        ? `the router rejected the key: run \`${remedy}\``
        : "the router rejected the key: re-login to the selected profile",
    );
  }

  // Resolved before the write, so a missing `claude` leaves no settings file
  // behind for a session that never ran.
  const claudePath = resolveClaude(deps);
  if (typeof claudePath === "number") return claudePath;

  const config = loaded.config;
  const catalog = resolveCatalog(config, probe.rows);
  const model = sessionModel(
    config,
    catalog,
    deps.env,
    readSavedModel(deps.env),
    explicitModel(userArgs),
  );
  const settings = buildSettings(config, deps, deps.env, profile, { catalog, model });
  const payload = `${JSON.stringify(settings, null, 2)}\n`;
  if (keyFragmentOffset(payload, config.key) !== undefined) {
    return fail(deps, 78, "generated settings contain router key material");
  }
  const settingsPath = launchSettingsPath(loaded.dir, profile, payload);
  argv.argv[launchClass === "dispatch" ? 2 : 1] = settingsPath;
  try {
    writeLaunchSettings(settingsPath, payload);
  } catch (err) {
    return fail(deps, 1, settingsWriteError(err, settingsPath));
  }

  for (const note of [...catalog.notes, ...model.notes]) {
    deps.stderr(`note: ${note}\n`);
  }

  // The settings file stays on disk after this launcher exits (see above), so
  // there is no cleanup on any exit path from here on.
  return await execClaude(claudePath, argv.argv, deps);
}

/** The shared shape of the two rerouting refusals: exit 64, the name only. */
function refuseReroute(deps: RunDeps, name: string): number {
  return fail(
    deps,
    64,
    `claudes: refusing: ${name} is set, so this session would not go to the router`,
  );
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

function resolveClaude(deps: RunDeps): string | number {
  const candidate = resolveExecutable("claude", deps.env);
  if (candidate === undefined) {
    return fail(deps, 127, CLAUDE_NOT_FOUND_MESSAGE, [CLAUDE_INSTALL_HINT]);
  }
  try {
    if (realpathSync(candidate) === deps.scriptPath) {
      return fail(deps, 127, SELF_REFERENCE_MESSAGE);
    }
  } catch {
    // The candidate may have disappeared. The spawn reports that failure.
  }
  return candidate;
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
 * to launch. Exported for `claudes doctor`, whose wiring probe must resolve
 * the very same script a real launch would.
 */
export function runningScriptPath(): string {
  const entry = resolve(process.argv[1] ?? "claudes");
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}
