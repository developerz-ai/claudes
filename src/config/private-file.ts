import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "./errors";

export interface PrivateWriteHooks {
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

export interface PrivateWriteOptions {
  /** Names the file in refusal messages, e.g. "config" or "settings". */
  readonly noun: string;
  /** The remedy appended to the symlink refusal, e.g. `re-run "claudes login"`. */
  readonly remedy: string;
  /**
   * Defaults to process.getuid; injectable so tests stay pure (a foreign-owned
   * directory cannot be created without root).
   */
  readonly getuid?: () => number | undefined;
  readonly hooks?: PrivateWriteHooks;
}

/**
 * Atomically replaces a private (0600) file at `path`: the directory is created
 * with mode 0700 (and re-chmodded to 0700 if it already exists — after symlink
 * and ownership refusals), the payload goes to a sibling temp file with mode
 * 0600, is fully written, fsynced, verified against the fd's own stat, renamed
 * over `path`, and the containing directory fsynced so the rename is durable.
 * Shared by the config store and the launcher's generated Claude Code settings
 * file.
 */
export function writePrivateFile(
  path: string,
  payload: string,
  options: PrivateWriteOptions,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  // chmod follows symlinks, so a symlinked directory would tighten somebody
  // else's directory; refuse it before touching the mode.
  if (dirStat.isSymbolicLink()) {
    throw new ConfigError(
      `refusing to write ${options.noun}: ${dir} is a symbolic link — ${options.remedy}`,
    );
  }
  // chmodding another user's directory can only surface as a raw EPERM — name
  // the real problem instead, with the remedy.
  const uid = (options.getuid ?? (() => process.getuid?.()))();
  if (uid !== undefined && dirStat.uid !== uid) {
    throw new ConfigError(
      `refusing to write ${options.noun}: ${dir} is owned by uid ${dirStat.uid}, not by you (uid ${uid}) — ${options.remedy}`,
    );
  }
  // mkdir's mode is filtered by the umask, so pin the mode explicitly — also
  // for a directory that already existed.
  chmodSync(dir, 0o700);

  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const writeFile = options.hooks?.writeFile ?? ((fd, data) => writeFileSync(fd, data, "utf8"));
  let fd: number | undefined = openSync(temp, "wx", 0o600);
  try {
    // open's mode is filtered by the umask, so pin 0600 on the open fd itself;
    // the file's permissions must not depend on the caller's umask.
    fchmodSync(fd, 0o600);
    writeFile(fd, payload);
    fsyncSync(fd);
    // Verify the write through the fd itself: a short write would otherwise be
    // renamed over the good file as a silently truncated one.
    const expectedBytes = Buffer.byteLength(payload, "utf8");
    const writtenBytes = fstatSync(fd).size;
    if (writtenBytes !== expectedBytes) {
      throw new ConfigError(
        `short write to ${temp}: wrote ${writtenBytes} of ${expectedBytes} bytes`,
      );
    }
    closeSync(fd);
    fd = undefined;
    options.hooks?.afterTempWrite?.(temp);
    renameSync(temp, path);
    fsyncDir(dir);
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

/** Errnos of platforms/filesystems that refuse to fsync a directory fd. */
const DIR_FSYNC_IGNORABLE_CODES = new Set<string>([
  "EINVAL",
  "EISDIR",
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EBADF",
]);

/**
 * fsyncs the directory entry so the rename itself survives a crash, not only
 * the file's contents (already fsynced on the fd). Best-effort: platforms
 * that refuse a directory fsync answer EINVAL/EISDIR/… and that is harmless
 * — the payload is durable either way — so only those errnos are swallowed.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !DIR_FSYNC_IGNORABLE_CODES.has(code)) {
      throw err;
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the dir fd is closed or unopenable; nothing left to do
      }
    }
  }
}
