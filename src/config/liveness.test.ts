import { describe, expect, test } from "bun:test";
import { pidIsAlive } from "./liveness";

/** A pid no kernel will hand out (above every pid_max, below kill()'s range). */
const DEAD_PID = 999_999_999;

describe("pidIsAlive", () => {
  test("this process is alive", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
  });

  test("another real process — the parent — is alive", () => {
    expect(pidIsAlive(process.ppid)).toBe(true);
  });

  test(`a pid no kernel hands out (${DEAD_PID}) is dead`, () => {
    expect(pidIsAlive(DEAD_PID)).toBe(false);
  });

  test("pid 1 is alive", () => {
    // For a non-root prober process.kill(1, 0) throws EPERM, which counts
    // as alive; under root pid 1 genuinely exists. Either way: alive.
    expect(pidIsAlive(1)).toBe(true);
  });
});
