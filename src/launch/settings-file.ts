import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config/errors";
import { settingsFile } from "../config/paths";
import { errorName } from "../router/errors";

/**
 * The lifetime of the generated Claude Code settings file. Its env can carry
 * the shell's proxy URL — userinfo included — and it is 0600 inside the 0700
 * config dir that already holds the router key in config.json, so the file
 * lives until a later launch sweeps it after the launching process has exited.
 * It is deliberately NOT removed when the direct child exits: Claude Code
 * hands the --settings path to processes it starts later (/restart, the inner
 * claude of a --tmux session, background agents), which read the file fresh
 * from disk, possibly after the launcher has exited. A descendant still
 * running from a dead launcher's session loses the file at that sweep and
 * fails closed ("Settings file not found").
 */

/**
 * Per-launch settings files: settings.<pid>.json (a positive pid), plus the
 * stranded temp sibling settings.<pid>.json.tmp-* a SIGKILL can leave between
 * the temp-open and the rename of an atomic write.
 */
const LAUNCH_SETTINGS_PATTERN = /^settings\.([1-9]\d*)\.json(\.tmp-.+)?$/;

/** The fixed name an older build wrote on every launch; removed when found. */
const LEGACY_SETTINGS_NAME = "settings.json";

/** The settings path of this launch: `${dir}/settings.<process.pid>.json`. */
export function launchSettingsPath(dir: string): string {
  return settingsFile(dir, process.pid);
}

/**
 * Removes the settings files of launches that can no longer be running: every
 * settings.<pid>.json — and its stranded settings.<pid>.json.tmp-* sibling —
 * whose pid is dead, and the fixed settings.json an older build left behind.
 * A file whose pid is alive is never touched — including a pid this process
 * may not signal (the liveness probe answers EPERM), which is treated as
 * alive. Anything else in the dir (config.json, another user's files) is not
 * the launcher's to remove.
 */
export function sweepStaleLaunchSettings(dir: string): void {
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no config dir yet: nothing stale to sweep
  }
  for (const name of names) {
    if (name === LEGACY_SETTINGS_NAME) {
      remove(join(dir, name));
      continue;
    }
    const pid = LAUNCH_SETTINGS_PATTERN.exec(name)?.[1];
    if (pid !== undefined && !pidIsAlive(Number(pid))) {
      remove(join(dir, name));
    }
  }
}

/**
 * The reason a settings write failed, for the refusal message: a ConfigError
 * already carries a key-free, remedy-bearing message of its own; anything
 * else is named by its errno-shaped `code` when it has one.
 */
export function settingsWriteError(err: unknown, settingsPath: string): string {
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

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone, or unremovable now: a later launch's sweep covers it
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
