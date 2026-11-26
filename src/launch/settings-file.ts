import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "../config/errors";
import { settingsFile } from "../config/paths";
import { writePrivateFile } from "../config/private-file";
import { errorName } from "../router/errors";

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GENERATED_NAME = /^settings\.([a-z0-9][a-z0-9-]{0,31})\.[0-9a-f]{16}\.json(?:\.tmp-.+)?$/;
const TEMP_NAME =
  /^(?:settings\.[1-9]\d*|settings\.[a-z0-9][a-z0-9-]{0,31}\.[0-9a-f]{16})\.json\.tmp-.+$/;

export function launchSettingsPath(dir: string, profile: string, payload: string): string {
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return settingsFile(dir, profile, digest);
}

function privateSettingsMatch(path: string, payload: string): boolean {
  const uid = process.getuid?.();
  let fd: number | undefined;
  try {
    const directory = lstatSync(dirname(path));
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o777) !== 0o700 ||
      (uid !== undefined && directory.uid !== uid)
    )
      return false;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    return (
      file.isFile() &&
      (file.mode & 0o777) === 0o600 &&
      (uid === undefined || file.uid === uid) &&
      file.size === Buffer.byteLength(payload) &&
      readFileSync(fd, "utf8") === payload
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeLaunchSettings(path: string, payload: string): void {
  if (privateSettingsMatch(path, payload)) return;
  writePrivateFile(path, payload, {
    noun: "settings",
    remedy: 'remove it and re-run "claudes login"',
  });
}

/** Detached sessions may need any completed settings file. Sweep only old atomic-write leftovers. */
export function sweepStaleLaunchSettings(dir: string, now = Date.now()): void {
  let names: string[];
  const uid = process.getuid?.();
  try {
    const directory = lstatSync(dir);
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      (uid !== undefined && directory.uid !== uid)
    )
      return;
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (
        stat.isFile() &&
        (uid === undefined || stat.uid === uid) &&
        now - stat.mtimeMs > TEMP_MAX_AGE_MS
      ) {
        unlinkSync(path);
      }
    } catch {
      // A later launch can retry, unless another process has already removed it.
    }
  }
}

/** Called only inside the profile mutation lock and a verified private directory. */
export function removeProfileSettings(dir: string, profile: string): void {
  const uid = process.getuid?.();
  for (const name of readdirSync(dir)) {
    if (GENERATED_NAME.exec(name)?.[1] !== profile) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && (uid === undefined || stat.uid === uid)) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
