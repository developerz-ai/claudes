import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { type Config, configSchema, formatZodIssues } from "./schema";

/** Base error for a config file we refuse to trust or cannot use. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The config file, or its directory, would expose the key to other users. */
export class InsecureConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "InsecureConfigError";
  }
}

export interface WriteHooks {
  /**
   * Test seam called after the temp file is fully written but before the
   * rename, so a crash between the two steps can be simulated.
   */
  afterTempWrite?: (tempPath: string) => void;
}

export interface ReadOptions {
  /** Defaults to process.getuid; injectable so tests stay pure. */
  getuid?: () => number | undefined;
}

/**
 * Atomically replaces the config at `path`: the directory is created with mode
 * 0700 (and re-chmodded to 0700 if it already exists), the payload goes to a
 * sibling temp file with mode 0600, is fsynced, then renamed over `path`.
 */
export function writeConfig(path: string, config: Config, hooks: WriteHooks = {}): void {
  const check = configSchema.safeParse(config);
  if (!check.success) {
    throw new ConfigError(`refusing to write an invalid config: ${formatZodIssues(check.error)}`);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is filtered by the umask, so pin the mode explicitly — also
  // for a directory that already existed.
  chmodSync(dir, 0o700);

  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  let fd: number | undefined = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, payload, null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    hooks.afterTempWrite?.(temp);
    renameSync(temp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the fd may already be closed
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // the temp file may never have been created
    }
    throw err;
  }
}

/**
 * Reads and validates the config at `path`. Refuses — with the exact chmod fix
 * in the message — when the file, or its directory, is accessible by group or
 * other, or when the file is not owned by the current uid.
 */
export function readConfig(path: string, options: ReadOptions = {}): Config {
  const getuid = options.getuid ?? (() => process.getuid?.());
  const dir = dirname(path);

  const dirStat = statOrConfigError(dir, path);
  if ((dirStat.mode & 0o077) !== 0) {
    throw new InsecureConfigError(
      `refusing to read config: directory ${dir} is accessible by group or other users — fix it with: chmod 700 ${dir}`,
    );
  }

  const fileStat = statOrConfigError(path, path);
  if (fileStat.isDirectory()) {
    if ((fileStat.mode & 0o077) !== 0) {
      throw new InsecureConfigError(
        `refusing to read config: ${path} is a directory accessible by group or other users — fix it with: chmod 700 ${path}`,
      );
    }
    throw new ConfigError(`config path ${path} is a directory, not a file`);
  }
  if ((fileStat.mode & 0o077) !== 0) {
    throw new InsecureConfigError(
      `refusing to read config: ${path} is readable by group or other users — fix it with: chmod 600 ${path}`,
    );
  }
  const uid = getuid();
  if (uid !== undefined && fileStat.uid !== uid) {
    throw new InsecureConfigError(
      `refusing to read config: ${path} is owned by uid ${fileStat.uid}, not by you (uid ${uid})`,
    );
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `${path} is not a valid claudes config: ${formatZodIssues(result.error)}`,
    );
  }
  return result.data;
}

function statOrConfigError(target: string, forPath: string): Stats {
  try {
    return statSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`no config at ${forPath} — run "claudes login" first`);
    }
    throw err;
  }
}
