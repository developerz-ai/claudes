import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configDir, type Env } from "../../config/paths";
import { writePrivateFile } from "../../config/private-file";
import type { Config } from "../../config/schema";
import { writeConfig } from "../../config/store";
import { buildArgv } from "../../launch/argv";
import { buildChildEnv } from "../../launch/env";
import { buildSettings } from "../../launch/settings";
import type { CheckResult } from "../results";
import type { ProcResult, RunProc } from "../run-proc";
import { createRouterStub, credentialHash, type RouterStub } from "../stub-server";

/** The issue's budget for the whole probe: a normal run finishes in ~20 s. */
export const WIRING_TIMEOUT_MS = 60_000;

/**
 * The probe's claude arguments, on top of the launcher's own argv. Every flag
 * was verified against `claude --help` on 2.1.300 and then live: `--safe-mode`
 * disables hooks, installed plugins, skills and MCP servers (settings-file
 * auth still works), `--strict-mcp-config` keeps MCP servers from starting
 * even if one is configured elsewhere, and `--no-session-persistence` (a
 * --print-only flag) keeps the probe from writing session history. With
 * `-p ping --max-turns 1` the probe answers one turn and exits.
 */
export const WIRING_ARGS = [
  "-p",
  "ping",
  "--max-turns",
  "1",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--safe-mode",
] as const;

/**
 * The signals the probe traps while the key's only disk copy is on disk. An
 * interrupted doctor run must not strand that copy, so the handler deletes it
 * and then re-raises the signal.
 */
export const PROBE_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** One of the signals the probe traps. */
export type ProbeSignal = (typeof PROBE_SIGNALS)[number];

/**
 * How the probe subscribes to the signals it traps, and how it re-raises one.
 * The handler removes its own listener before the re-raise, so the signal
 * finds the default disposition again and the process dies of the signal it
 * was sent instead of being swallowed by a handler that is still installed.
 */
export interface ProbeSignalWiring {
  readonly on: (signal: ProbeSignal, handler: () => void) => void;
  readonly off: (signal: ProbeSignal, handler: () => void) => void;
  /** Re-raises the signal on this process, so its exit status stays the signal's. */
  readonly raise: (signal: ProbeSignal) => void;
}

export interface WiringDeps {
  readonly env: Env;
  /** Where the running claudes lives, for the settings' apiKeyHelper. */
  readonly nodePath: string;
  readonly scriptPath: string;
  /** The resolved `claude` path, or undefined when it is not on PATH. */
  readonly claudePath: string | undefined;
  readonly runProc: RunProc;
  /**
   * Creates the probe's throwaway tree under `base` (the config directory)
   * and returns its path. Defaults to createProbeDir.
   */
  readonly probeDir?: (base: string) => string;
  /** Removes a file or a tree; the probe's cleanup. */
  readonly rm?: (path: string) => void;
  /** The signals the probe traps; defaults to this process's own. */
  readonly signals?: ProbeSignalWiring;
  readonly createStub?: () => Promise<RouterStub>;
  readonly timeoutMs?: number;
}

const defaultRm = (path: string): void => {
  rmSync(path, { recursive: true, force: true });
};

const processSignals: ProbeSignalWiring = {
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.removeListener(signal, handler),
  raise: (signal) => {
    process.kill(process.pid, signal);
  },
};

/**
 * The probe's throwaway tree: `${base}/probe.<pid>`, mode 0700. It lives under
 * the config directory — not in the OS temp directory — so the documented
 * uninstall reaches it and the next doctor run can sweep it again.
 *
 * A symlinked `base` is refused: mkdir follows the link, so the key's only
 * disk copy would land in the link's target — where neither the dead-pid
 * sweep nor the documented uninstall (which removes the link, not its target)
 * reaches it. The config store refuses a symlinked config directory for the
 * same reason (config/private-file.ts). The tree's own path is refused for
 * the same reason: `probe.<pid>` is a name inside the config directory, and
 * a link planted there sends the copy out of the uninstall tree just the
 * same.
 */
export function createProbeDir(base: string): string {
  refuseSymlink(base, "config directory");
  const dir = join(base, `probe.${process.pid}`);
  createPrivateDir(dir, "probe directory");
  return dir;
}

/**
 * Creates a private directory (mode 0700) at `path`, refusing to follow a
 * symbolic link. mkdir's recursive mode follows a link that already sits at
 * the path, and chmod follows it too, so the key's only disk copy would land
 * in the link's target — outside the uninstall tree, where neither the sweep
 * nor the documented uninstall reaches it. The path is lstat'ed before and
 * after the mkdir: the first check names a link that is already there, the
 * second one a link that appeared while the directory was being created.
 */
function createPrivateDir(path: string, what: string): void {
  refuseSymlink(path, what);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  refuseSymlink(path, what);
  // mkdir's mode is filtered by the umask, so pin it explicitly.
  chmodSync(path, 0o700);
}

/**
 * Refuses a symlinked path before the probe writes into it. The rule is the
 * config store's own: a link's target is somebody else's directory, and the
 * key's only disk copy must not end up where neither the sweep nor the
 * documented uninstall reaches it.
 */
function refuseSymlink(path: string, what: string): void {
  if (isSymlink(path)) {
    throw new SymlinkedPathError(path, what);
  }
}

/** True when `path` is a symbolic link; false when there is nothing there. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    // Nothing there yet: mkdir creates it, so there is no link to follow.
    if (errCodeOf(err) === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * The refusal a symlinked path earns: the probe's tree — and with it the
 * key's only disk copy — would be created inside the link's target.
 */
class SymlinkedPathError extends Error {
  /** What the refused path is, e.g. "config directory"; the fix line names it. */
  readonly what: string;

  constructor(path: string, what: string) {
    super(`the ${what} ${path} is a symbolic link`);
    this.name = "SymlinkedPathError";
    this.what = what;
  }
}

/** The trap-safe `instanceof` for the symlink refusal. */
function isSymlinkedPathError(err: unknown): err is SymlinkedPathError {
  try {
    return err instanceof SymlinkedPathError;
  } catch {
    return false;
  }
}

/** The probe trees a doctor run leaves behind: `probe.<pid>` (a positive pid). */
const PROBE_DIR_PATTERN = /^probe\.([1-9]\d*)$/;

/**
 * Check 5: the wiring proof, zero quota. Spawns the real `claude` exactly the
 * way the launcher would — the same buildSettings/buildChildEnv/buildArgv —
 * but with the base URL pointed at a local recording stub, and passes only if
 * that stub saw a POST /v1/messages whose credential hash is the configured
 * key's, with a configured tier as the model, and no other credential
 * anywhere. The key itself never appears in the generated settings file, in
 * the probe's output, or in the stub's records (SHA-256 hex only). It DOES
 * land in the throwaway probe config at
 * `<config dir>/probe.<pid>/xdg/claudes/config.json` (mode 0600, inside 0700
 * directories) — `claudes key` can only serve it from a config — and that
 * copy's lifetime is the probe's own: it exists while the probe's child runs,
 * it is deleted the moment that child exits (on the PASS path and on the FAIL
 * path alike), and a SIGINT or SIGTERM deletes it before the process dies.
 * The tree around it lives under the config directory, so the documented
 * uninstall reaches what a crash left behind and the next doctor run sweeps a
 * tree whose pid is dead. A symlinked path is refused outright — the config
 * directory, the probe's own tree, or a directory inside it: the copy would
 * live in the link's target, where neither the uninstall nor the sweep
 * reaches it.
 *
 * The copy's deletion is verified, not assumed: a copy that could not be
 * deleted keeps its signal traps armed (so a signal still takes it) and
 * FAILs the check with the copy's path, instead of claiming a clean run.
 *
 * Two deliberate probe substitutions, both because the stub is not the real
 * router: the settings' base URL (the point of the probe) and the child's
 * HOME/XDG_CONFIG_HOME, which point at a throwaway copy of the config with the
 * stub's base URL — `claudes key` refuses to serve the key when the settings'
 * base URL is not the config's, so the probe config must agree with the stub.
 * The throwaway HOME also keeps claude from touching the developer's real
 * state, and keeps their user settings from making the probe non-determinic.
 */
export async function checkWiring(deps: WiringDeps, config: Config): Promise<CheckResult> {
  if (deps.claudePath === undefined) {
    return {
      status: "FAIL",
      title: "wiring probe: claude not found on PATH",
      fix: "install Claude Code and make `claude` resolvable on PATH",
    };
  }
  const rm = deps.rm ?? defaultRm;
  const createStub = deps.createStub ?? createRouterStub;
  const signals = deps.signals ?? processSignals;

  let probeRoot: string | undefined;
  let keyCopy: string | undefined;
  let stub: RouterStub | undefined;
  let strandedCopy: string | undefined;
  const traps: { readonly signal: ProbeSignal; readonly handler: () => void }[] = [];

  // The key's only disk copy. It goes when the probe's child goes, and when a
  // signal arrives before that. The answer says whether the copy is gone: a
  // removal that failed must not be read as a removal that worked.
  const removeKeyCopy = (): boolean => {
    if (keyCopy === undefined) {
      return true;
    }
    try {
      rm(keyCopy);
    } catch {
      // the tree removal below may still take it with it
    }
    return !existsSync(keyCopy);
  };

  let outcome: CheckResult;
  try {
    // The probe's tree belongs under the config directory, so the documented
    // uninstall reaches it and a dead-pid sweep can find it again.
    const base = configDir(deps.env);
    sweepStaleProbeDirs(base, rm);
    probeRoot = (deps.probeDir ?? createProbeDir)(base);

    // Trapped before the copy is written, so no window exists in which a
    // signal could kill the process with the copy still on disk.
    for (const signal of PROBE_SIGNALS) {
      const handler = (): void => {
        removeKeyCopy();
        signals.off(signal, handler);
        signals.raise(signal);
      };
      traps.push({ signal, handler });
      signals.on(signal, handler);
    }

    stub = await createStub();

    // The probe config: the real key and tiers, the stub's base URL.
    const probeConfig: Config = { ...config, baseUrl: stub.baseUrl };
    const settingsDir = join(probeRoot, "settings");
    const settingsPath = join(settingsDir, "settings.json");
    writePrivateFile(
      settingsPath,
      `${JSON.stringify(buildSettings(probeConfig, deps, deps.env), null, 2)}\n`,
      {
        noun: "wiring-probe settings",
        remedy: "re-run `claudes doctor`",
      },
    );
    // The child's XDG_CONFIG_HOME: a throwaway tree inside the probe's own
    // tree, holding the key's only disk copy.
    const probeXdg = join(probeRoot, "xdg");
    createPrivateDir(probeXdg, "probe directory");
    keyCopy = join(probeXdg, "claudes", "config.json");
    writeConfig(keyCopy, probeConfig);
    const probeHome = join(probeRoot, "home");
    createPrivateDir(probeHome, "probe directory");

    const argv = buildArgv([...WIRING_ARGS], settingsPath);
    if (!argv.ok) {
      outcome = { status: "FAIL", title: `wiring probe: ${argv.message}` };
    } else {
      const childEnv = buildChildEnv(deps.env);
      childEnv.HOME = probeHome;
      childEnv.XDG_CONFIG_HOME = probeXdg;

      const proc = await deps.runProc(deps.claudePath, argv.argv, {
        env: childEnv,
        timeoutMs: deps.timeoutMs ?? WIRING_TIMEOUT_MS,
      });
      // The child is gone: the key's only disk copy goes with it.
      removeKeyCopy();
      outcome = evaluate(stub, config, proc, deps.timeoutMs ?? WIRING_TIMEOUT_MS);
    }
  } catch (err) {
    if (isSymlinkedPathError(err)) {
      outcome = {
        status: "FAIL",
        title: `wiring probe: ${err.message} — the probe will not write the key's only disk copy into its target`,
        fix: `replace the symlinked ${err.what} with a real directory and re-run \`claudes doctor\``,
      };
    } else {
      outcome = {
        status: "FAIL",
        title: `wiring probe: could not run (${errorToken(err)})`,
        fix: "re-run `claudes doctor`",
      };
    }
  } finally {
    // First: delete the key's only disk copy while the traps are still armed.
    // Detaching them (or awaiting the stub's close) before this would leave a
    // window in which a signal strands the copy on disk.
    const copyGone = removeKeyCopy();
    if (copyGone) {
      for (const { signal, handler } of traps) {
        signals.off(signal, handler);
      }
    }
    // A copy that would not go keeps its traps: a signal arriving during the
    // rest of the teardown still deletes it.
    try {
      await stub?.close();
    } catch {
      // the socket is gone either way
    }
    if (probeRoot !== undefined) {
      try {
        rm(probeRoot);
      } catch {
        // the next run's dead-pid sweep covers it
      }
    }
    // The copy is stranded only when neither its own removal nor the tree's
    // took it: then the verdict below says so instead of claiming a clean
    // run.
    if (!copyGone && keyCopy !== undefined && existsSync(keyCopy)) {
      strandedCopy = keyCopy;
    }
  }
  if (strandedCopy !== undefined) {
    return {
      status: "FAIL",
      title: `wiring probe: the key's only disk copy (${strandedCopy}) could not be deleted`,
      fix: "remove it and re-run `claudes doctor`",
    };
  }
  return outcome;
}

/**
 * Removes the probe trees of doctor runs that can no longer be running: every
 * `probe.<pid>` whose pid is dead. A live pid's tree is never touched — a
 * concurrent doctor run owns it — and anything else in the config directory is
 * not the probe's to remove. A symlinked config directory is not swept at all:
 * createProbeDir refuses one, so the probe never writes a tree into its
 * target.
 *
 * Liveness is judged in this process's pid namespace, the same rule the
 * per-launch settings sweep uses, so a config directory shared across
 * containers can see another namespace's live doctor run as dead.
 */
function sweepStaleProbeDirs(base: string, rm: (path: string) => void): void {
  let names: readonly string[];
  try {
    if (lstatSync(base).isSymbolicLink()) {
      return;
    }
    names = readdirSync(base);
  } catch {
    return; // no config directory yet: nothing stale to sweep
  }
  for (const name of names) {
    const pid = PROBE_DIR_PATTERN.exec(name)?.[1];
    if (pid !== undefined && !pidIsAlive(Number(pid))) {
      try {
        rm(join(base, name));
      } catch {
        // a later doctor run's sweep covers it
      }
    }
  }
}

/** True when `pid` names a process this one can probe (EPERM still means alive). */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCodeOf(err) !== "ESRCH";
  }
}

/** The errno-shaped `err.code`, when the thrown value carries a string one. */
function errCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/** The PASS/WARN/FAIL verdict over what the stub recorded and how claude left. */
function evaluate(
  stub: RouterStub,
  config: Config,
  proc: ProcResult,
  timeoutMs: number,
): CheckResult {
  const expected = credentialHash(config.key);
  const requests = stub.requests();
  const foreign = requests
    .flatMap((request) => request.credentials)
    .filter((c) => c.hash !== expected);
  if (foreign.length > 0) {
    return {
      status: "FAIL",
      title: `wiring probe: ${foreign.length} credential${foreign.length === 1 ? "" : "s"} other than the configured router key reached the probe`,
      fix: "remove the competing credential (see the conflicts check above) and re-run `claudes doctor`",
    };
  }
  const hits = requests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/v1/messages" &&
      request.credentials.some((c) => c.hash === expected),
  );
  if (hits.length === 0) {
    if (proc.timedOut) {
      return {
        status: "FAIL",
        title: `wiring probe: claude did not finish within ${Math.round(timeoutMs / 1000)} s`,
        fix: "retry `claudes doctor`; a cold first start can outlast the probe",
      };
    }
    return {
      status: "FAIL",
      title: `wiring probe: claude ${describeExit(proc)} without sending a request to the probe`,
      fix: "the generated settings file must exist and be readable for the whole run — re-run `claudes doctor` and check the conflicts above",
    };
  }
  const tierIds = new Set<string>([config.tiers.opus, config.tiers.sonnet, config.tiers.haiku]);
  if (config.subagentModel !== undefined) {
    tierIds.add(config.subagentModel);
  }
  const hit = hits.find(
    (candidate) => candidate.model !== undefined && tierIds.has(candidate.model),
  );
  if (hit === undefined) {
    const model = hits.at(0)?.model;
    return {
      status: "FAIL",
      title: `wiring probe: the request's model (${model ?? "unreadable"}) is not a configured tier`,
      fix: "re-run `claudes login` so the pinned tiers match what the router serves",
    };
  }
  if (proc.timedOut || proc.code === null || proc.code !== 0) {
    return {
      status: "WARN",
      title: `wiring probe: the router key reached the probe as the only credential (model ${hit.model}), but claude ${describeExit(proc)}`,
      fix: "the credential path is proven; the exit status is a separate problem",
    };
  }
  return {
    status: "PASS",
    title: `wiring probe: claude sent the router key to the stub and nothing else (model ${hit.model})`,
  };
}

/** "exited 1" / "was killed by SIGKILL" / "could not run" — never a message body. */
function describeExit(proc: ProcResult): string {
  if (proc.signal !== null) {
    return `was killed by ${proc.signal}`;
  }
  if (proc.code !== null) {
    return `exited ${proc.code}`;
  }
  return "could not run";
}

/** Class-shaped error names only; an errno-shaped code wins when present. */
function errorToken(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
      return code;
    }
  }
  return err instanceof Error && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
}
