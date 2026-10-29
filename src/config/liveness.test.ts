import { describe, expect, test } from "bun:test";
import { pidIsAlive } from "./liveness";

/** A kill seam that answers like a successful probe and records its calls. */
function recordingKill(): {
  readonly kill: (pid: number, signal: number) => void;
  readonly calls: [pid: number, signal: number][];
} {
  const calls: [pid: number, signal: number][] = [];
  return {
    calls,
    kill: (pid, signal) => {
      calls.push([pid, signal]);
    },
  };
}

/** A kill seam that throws exactly the given value, the way process.kill fails. */
function throwingKill(thrown: unknown): (pid: number, signal: number) => void {
  return () => {
    throw thrown;
  };
}

describe("pidIsAlive", () => {
  test("answers true and probes once with signal 0 when the kill succeeds", () => {
    const { kill, calls } = recordingKill();
    expect(pidIsAlive(4711, kill)).toBe(true);
    expect(calls).toEqual([[4711, 0]]);
  });

  test("answers false only for ESRCH", () => {
    expect(pidIsAlive(4711, throwingKill({ code: "ESRCH" }))).toBe(false);
  });

  test("answers true for EPERM: a pid this process may not signal is alive", () => {
    expect(pidIsAlive(1, throwingKill({ code: "EPERM" }))).toBe(true);
  });

  test("answers true for any other errno-shaped probe error", () => {
    expect(pidIsAlive(4711, throwingKill({ code: "EACCES" }))).toBe(true);
  });

  test("answers true for an Error without a code", () => {
    expect(pidIsAlive(4711, throwingKill(new Error("signalling denied")))).toBe(true);
  });

  test("answers true without throwing when the kill throws null or a string", () => {
    expect(pidIsAlive(4711, throwingKill(null))).toBe(true);
    expect(pidIsAlive(4711, throwingKill("process.kill died"))).toBe(true);
  });

  test("answers true without throwing when the thrown value's code getter throws", () => {
    const poison: unknown = {
      get code(): string {
        throw new Error("unreadable code");
      },
    };
    expect(pidIsAlive(4711, throwingKill(poison))).toBe(true);
  });

  test("the default probe sees this process as alive and no pid above pid_max", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
    expect(pidIsAlive(999_999_999)).toBe(false);
  });
});
