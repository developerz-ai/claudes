import { describe, expect, test } from "bun:test";
import { realRunProc } from "./run-proc";

/**
 * The one suite that exercises the REAL spawn seam: every doctor check injects
 * a fake, so the kill-on-timeout, settle-once and stdout-cap logic would
 * otherwise never run under test. process.execPath is whatever runtime hosts
 * the suite (node or bun); both accept -e.
 */
describe("realRunProc", () => {
  test("captures a quick child's stdout and exit code (settled from 'close')", async () => {
    const proc = await realRunProc(process.execPath, ["-e", "process.stdout.write('hi')"], {
      timeoutMs: 10_000,
    });
    expect(proc).toEqual({ ok: true, code: 0, signal: null, timedOut: false, stdout: "hi" });
  });

  test("kills a long-lived child at the deadline: timedOut true, code null, no hang", async () => {
    const started = Date.now();
    const proc = await realRunProc(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 100,
    });
    expect(proc.timedOut).toBe(true);
    expect(proc.code).toBeNull();
    expect(proc.ok).toBe(false);
    // The promise settles from the timeout itself, not from the killed
    // child's 'close', so this is far under the next whole second.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a nonexistent command answers ok false, timedOut false, code null", async () => {
    const proc = await realRunProc("/nonexistent/claudes-doctor-no-such-binary", [], {
      timeoutMs: 1_000,
    });
    expect(proc.ok).toBe(false);
    expect(proc.timedOut).toBe(false);
    expect(proc.code).toBeNull();
  });
});
