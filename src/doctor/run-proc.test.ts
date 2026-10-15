import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realRunProc } from "./run-proc";

/**
 * The one suite that exercises the REAL spawn seam: every doctor check injects
 * a fake, so the kill-on-timeout, settle-once and stdout-cap logic would
 * otherwise never run under test.
 *
 * Both spawn tests park a detached grandchild on the stdout pipe so that the
 * child's exit (or its SIGKILL) and the stream's 'close' land seconds apart:
 * settling on the wrong event then changes the observable result instead of
 * hiding behind same-tick timing. The children are /bin/sh, not `execPath -e`:
 * sh boots in milliseconds, so the child has spawned its grandchild long
 * before any deadline fires — a bun/node -e child can take seconds to boot on
 * a loaded host, which would let the kill race the grandchild's creation.
 * bin/check already assumes a POSIX sh, so this adds no new requirement.
 *
 * Each child writes its grandchild's pid to the file named by $1 — stdout
 * cannot carry it, since a misbehaving run-proc settles before the pipe
 * closes — and the test SIGKILLs that pid afterwards so no sleeping
 * grandchild outlives the run.
 */
const pidFiles: string[] = [];

function gpidFile(tag: string): string {
  const file = join(tmpdir(), `claudes-run-proc-${process.pid}-${tag}.pid`);
  pidFiles.push(file);
  return file;
}

/** SIGKILLs the grandchild named by the pid file, then removes the file. */
function sweep(file: string): void {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
    if (pid > 0) {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // No file yet (the child died before writing) or ESRCH (already reaped).
  }
  rmSync(file, { force: true });
}

afterEach(() => {
  for (const file of pidFiles.splice(0)) {
    sweep(file);
  }
});

describe("realRunProc", () => {
  test("settled from 'close': a grandchild's post-exit write still arrives whole", async () => {
    const file = gpidFile("close");
    // The child prints HEAD and exits at once; the backgrounded grandchild
    // inherits the stdout pipe and prints TAIL 400ms later. 'exit' therefore
    // fires with only HEAD delivered, half a second before 'close' — a
    // run-proc settled on 'exit' would resolve with stdout "HEAD".
    const script = "printf HEAD; sh -c 'sleep 0.4; printf TAIL' & echo $! > \"$1\"; exit 0";
    try {
      const proc = await realRunProc("/bin/sh", ["-c", script, "sh", file], {
        timeoutMs: 10_000,
      });
      expect(proc).toEqual({
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "HEADTAIL",
      });
    } finally {
      sweep(file);
    }
  });

  test("kills a long-lived child at the deadline even while a grandchild holds stdout", async () => {
    const file = gpidFile("timeout");
    // The child sleeps forever; its backgrounded grandchild inherits the
    // stdout pipe and sleeps 4s, so after the SIGKILL the stream's 'close'
    // cannot fire until the grandchild dies. The 500ms deadline leaves the
    // millisecond-booting sh ample time to spawn the grandchild first. A
    // run-proc whose timer only kills and then waits on 'close' would
    // resolve ~4s in; the real one resolves straight from the timer.
    const script = 'sleep 4 & echo $! > "$1"; exec sleep 3600';
    const started = Date.now();
    try {
      const proc = await realRunProc("/bin/sh", ["-c", script, "sh", file], {
        timeoutMs: 500,
      });
      expect(proc.timedOut).toBe(true);
      expect(proc.code).toBeNull();
      expect(proc.ok).toBe(false);
      // Settled by the timer itself: far short of the grandchild's 4s sleep.
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      sweep(file);
    }
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
