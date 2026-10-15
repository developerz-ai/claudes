import { spawn } from "node:child_process";
import type { Env } from "../config/paths";

/** The outcome of one doctor-driven child process. */
export interface ProcResult {
  /** True when the child ran and exited by itself (any code, no timeout). */
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** The child's stdout, capped at MAX_STDOUT_BYTES; stderr is never read. */
  readonly stdout: string;
}

export interface ProcOptions {
  /** The child's whole env; omitted means inherit this process's. */
  readonly env?: Env;
  readonly timeoutMs: number;
}

/**
 * Runs one child to completion under a wall-clock timeout. Doctor's only spawn
 * seam: unit tests inject a fake instead of any real binary, and the two real
 * callers (`claude --version`, the wiring probe) share the kill-on-timeout
 * rule. stderr is dropped unread — a child's diagnostics are not doctor's to
 * relay, and claude's could quote credentials.
 */
export type RunProc = (
  command: string,
  argv: readonly string[],
  options: ProcOptions,
) => Promise<ProcResult>;

/** `claude --version` fits in bytes; anything larger is garbage anyway. */
const MAX_STDOUT_BYTES = 4096;

export const realRunProc: RunProc = (command, argv, options) =>
  new Promise<ProcResult>((resolve) => {
    const child = spawn(command, [...argv], {
      stdio: ["ignore", "pipe", "ignore"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += chunk.toString("utf8").slice(0, MAX_STDOUT_BYTES - stdout.length);
      }
    });
    let timedOut = false;
    let settled = false;
    const settle = (code: number | null, signal: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && code !== null, code, signal, timedOut, stdout });
    };
    const timer = setTimeout(() => {
      // The deadline passed: nothing the child says now matters, and a SIGKILL
      // cannot be trapped or delayed into a clean partial write. Settle right
      // here rather than waiting on the exit the kill causes — a grandchild
      // holding the stdout pipe would otherwise keep 'close' (and this
      // promise) pending past the deadline.
      timedOut = true;
      child.kill("SIGKILL");
      settle(null, null);
    }, options.timeoutMs);
    // 'close', not 'exit': Node fires 'exit' while the child's stdio streams
    // can still hold unread bytes, so a version line could be read truncated.
    child.on("close", (code, signal) => {
      settle(code, signal);
    });
    child.on("error", () => {
      // ENOENT and friends: the child never ran.
      settle(null, null);
    });
  });
