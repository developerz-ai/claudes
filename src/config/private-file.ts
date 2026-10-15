import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
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
  readonly hooks?: PrivateWriteHooks;
}

/**
 * Atomically replaces a private (0600) file at `path`: the directory is created
 * with mode 0700 (and re-chmodded to 0700 if it already exists), the payload
 * goes to a sibling temp file with mode 0600, is fully written, fsynced,
 * verified against the fd's own stat, then renamed over `path`. Shared by the
 * config store and the launcher's generated Claude Code settings file.
 */
export function writePrivateFile(
  path: string,
  payload: string,
  options: PrivateWriteOptions,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // chmod follows symlinks, so a symlinked directory would tighten somebody
  // else's directory; refuse it before touching the mode.
  if (lstatSync(dir).isSymbolicLink()) {
    throw new ConfigError(
      `refusing to write ${options.noun}: ${dir} is a symbolic link — ${options.remedy}`,
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
