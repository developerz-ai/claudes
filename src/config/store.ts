import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
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
   * Test seam replacing the payload writer, e.g. to simulate a short write;
   * the post-write size check still runs against whatever it left behind.
   */
  writeFile?: (fd: number, payload: string) => void;
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
 * sibling temp file with mode 0600, is fully written, fsynced, verified against
 * the fd's own stat, then renamed over `path`.
 */
export function writeConfig(path: string, config: Config, hooks: WriteHooks = {}): void {
  const check = configSchema.safeParse(config);
  if (!check.success) {
    throw new ConfigError(`refusing to write an invalid config: ${formatZodIssues(check.error)}`);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // chmod follows symlinks, so a symlinked config dir would tighten somebody
  // else's directory; refuse it before touching the mode.
  if (lstatSync(dir).isSymbolicLink()) {
    throw new ConfigError(
      `refusing to write config: ${dir} is a symbolic link — remove it and re-run "claudes login"`,
    );
  }
  // mkdir's mode is filtered by the umask, so pin the mode explicitly — also
  // for a directory that already existed.
  chmodSync(dir, 0o700);

  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const writeFile = hooks.writeFile ?? ((fd, data) => writeFileSync(fd, data, "utf8"));
  let fd: number | undefined = openSync(temp, "wx", 0o600);
  try {
    writeFile(fd, payload);
    fsyncSync(fd);
    // Verify the write through the fd itself: a short write would otherwise be
    // renamed over the good config as a silently truncated file.
    const expectedBytes = Buffer.byteLength(payload, "utf8");
    const writtenBytes = fstatSync(fd).size;
    if (writtenBytes !== expectedBytes) {
      throw new ConfigError(
        `short write to ${temp}: wrote ${writtenBytes} of ${expectedBytes} bytes`,
      );
    }
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
 * Reads and validates the config at `path`. The file is opened with O_NOFOLLOW
 * (and O_NONBLOCK, so a FIFO at the path cannot hang the open) and every check
 * runs on the fd's own fstat, so a symlink swap or a chmod between the check
 * and the read cannot slide a different file in. Ownership is checked before
 * permissions: a foreign-owned file or directory is replaced, not chmodded.
 */
export function readConfig(path: string, options: ReadOptions = {}): Config {
  const getuid = options.getuid ?? (() => process.getuid?.());
  const uid = getuid();
  const dir = dirname(path);

  const dirStat = statOrConfigError(dir, path);
  if (uid !== undefined && dirStat.uid !== uid) {
    throw new InsecureConfigError(
      `refusing to read config: directory ${dir} is owned by uid ${dirStat.uid}, not by you (uid ${uid}) — remove it and re-run "claudes login"`,
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
    if (uid !== undefined && fileStat.uid !== uid) {
      throw new InsecureConfigError(
        `refusing to read config: ${path} is owned by uid ${fileStat.uid}, not by you (uid ${uid}) — run "claudes login" again to replace it`,
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
