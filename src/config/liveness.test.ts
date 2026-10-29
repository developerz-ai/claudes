import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { type KillProbe, pidIsAlive } from "./liveness";

/** A pid no kernel will hand out (above every pid_max, below kill()'s range). */
const DEAD_PID = 999_999_999;

/** An error carrying an errno-shaped `code`, the way the kernel's errors do. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A probe that records what it was asked and throws `thrown`. */
function probeThatThrows(thrown: unknown): {
  readonly kill: KillProbe;
  readonly calls: { readonly pid: number; readonly signal: 0 }[];
} {
  const calls: { pid: number; signal: 0 }[] = [];
  return {
    calls,
    kill: (pid, signal) => {
      calls.push({ pid, signal });
      throw thrown;
    },
  };
}

describe("pidIsAlive", () => {
  test("a pid no process has is dead", () => {
    expect(pidIsAlive(DEAD_PID)).toBe(false);
  });

  test("a live child's pid is alive", () => {
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)"]);
    try {
      expect(holder.pid).toBeDefined();
      expect(pidIsAlive(holder.pid as number)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("a probe that does not throw means the process is there", () => {
    const calls: { readonly pid: number; readonly signal: 0 }[] = [];
    const kill: KillProbe = (pid, signal) => {
      calls.push({ pid, signal });
    };
    expect(pidIsAlive(4242, kill)).toBe(true);
    // The probe asks the kernel with signal 0: it checks, it never signals.
    expect(calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  test("ESRCH means the process is gone: dead", () => {
    const { kill, calls } = probeThatThrows(errno("ESRCH"));
    expect(pidIsAlive(4242, kill)).toBe(false);
    expect(calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  test("EPERM means the process exists but is not ours to signal: alive", () => {
    const { kill } = probeThatThrows(errno("EPERM"));
    expect(pidIsAlive(1, kill)).toBe(true);
  });

  test("any other errno means the probe could not answer: alive", () => {
    for (const code of ["EINVAL", "EACCES", "ENOSYS"]) {
      const { kill } = probeThatThrows(errno(code));
      expect(pidIsAlive(1, kill)).toBe(true);
    }
  });

  test("a thrown value with no errno-shaped code means the probe could not answer: alive", () => {
    // A message that merely reads ESRCH is not a code: only the errno-shaped
    // `code` decides, so a sweep never retires a pid it could not judge.
    for (const thrown of [new Error("boom"), "ESRCH", { code: 42 }, null]) {
      const { kill } = probeThatThrows(thrown);
      expect(pidIsAlive(1, kill)).toBe(true);
    }
  });
});
