import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { ConfigError, InsecureConfigError } from "./errors";
import { type PrivateWriteHooks, writePrivateFile } from "./private-file";
import { type Config, configSchema, formatZodIssues } from "./schema";

export { ConfigError, InsecureConfigError } from "./errors";

export type WriteHooks = PrivateWriteHooks;

export interface ReadOptions {
  /**
   * Defaults to process.getuid; injectable so tests stay pure. Consulted once
   * per ownership check — directory, then file — so the two can disagree
   * exactly as they can on disk (an owned directory holding a foreign file).
   */
  getuid?: () => number | undefined;
}

/**
 * Atomically replaces the config at `path`: the directory is created with mode
 * 0700 (and re-chmodded to 0700 if it already exists), the payload goes to a
 * sibling temp file with mode 0600, is fully written, fsynced, verified against
 * the fd's own stat, then renamed over `path`.
 */
export function writeConfig(path: string, config: Config, hooks: WriteHooks = {}): void {
  const check = configSchema.safeParse(config);
  if (!check.success) {
    throw new ConfigError(`refusing to write an invalid config: ${formatZodIssues(check.error)}`);
  }
  writePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    noun: "config",
    remedy: 'remove it and re-run "claudes login"',
    hooks,
  });
}

/**
 * Reads and validates the config at `path`. The file is opened with O_NOFOLLOW
 * (and O_NONBLOCK, so a FIFO at the path cannot hang the open); the file's own
 * checks — isDirectory, isFile, uid, mode — run on the fd's own fstat, so a
 * symlink swap or a chmod between the check and the read cannot slide a
 * different file in. The directory's uid and mode are checked first, by path
 * (`statSync(dir)`), before the file is opened. Ownership is checked before
 * permissions: a foreign-owned file or directory is replaced, not chmodded.
 */
export function readConfig(path: string, options: ReadOptions = {}): Config {
  const getuid = options.getuid ?? (() => process.getuid?.());
  const dir = dirname(path);

  const dirUid = getuid();
  const dirStat = statOrConfigError(dir, path);
  if (dirUid !== undefined && dirStat.uid !== dirUid) {
    throw new InsecureConfigError(
      `refusing to read config: directory ${dir} is owned by uid ${dirStat.uid}, not by you (uid ${dirUid}) — remove it and re-run "claudes login"`,
    );
  }
  if ((dirStat.mode & 0o077) !== 0) {
    throw new InsecureConfigError(
      `refusing to read config: directory ${dir} is accessible by group or other users — fix it with: chmod 700 ${dir}`,
    );
  }

  const fd = openConfigFile(path);
  try {
    const fileStat = fstatSync(fd);
    if (fileStat.isDirectory()) {
      throw new ConfigError(
        `config path ${path} is a directory, not a file — remove it and re-run "claudes login"`,
      );
    }
    if (!fileStat.isFile()) {
      throw new ConfigError(
        `config path ${path} is not a regular file — remove it and re-run "claudes login"`,
      );
    }
    const fileUid = getuid();
    if (fileUid !== undefined && fileStat.uid !== fileUid) {
      throw new InsecureConfigError(
        `refusing to read config: ${path} is owned by uid ${fileStat.uid}, not by you (uid ${fileUid}) — run "claudes login" again to replace it`,
      );
    }
    if ((fileStat.mode & 0o077) !== 0) {
      throw new InsecureConfigError(
        `refusing to read config: ${path} is readable by group or other users — fix it with: chmod 600 ${path}`,
      );
    }

    const raw = readFileSync(fd, "utf8");
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
  } finally {
    closeSync(fd);
  }
}

function openConfigFile(path: string): number {
  try {
    // O_NOFOLLOW turns a symlinked config into an immediate ELOOP refusal;
    // O_NONBLOCK keeps a FIFO at the path from blocking the open forever.
    return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`no config at ${path} — run "claudes login" first`);
    }
    if (code === "ELOOP") {
      throw new InsecureConfigError(
        `refusing to read config: ${path} is a symbolic link — run "claudes login" again to replace it`,
      );
    }
    if (code !== undefined) {
      throw new ConfigError(
        `cannot read config at ${path} (${code}) — remove it and re-run "claudes login"`,
      );
    }
    throw err;
  }
}

function statOrConfigError(target: string, forPath: string): Stats {
  try {
    return statSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`no config at ${forPath} — run "claudes login" first`);
    }
    if (code !== undefined) {
      throw new ConfigError(
        `cannot read the config directory ${target} (${code}) — remove it and re-run "claudes login"`,
      );
    }
    throw err;
  }
}
