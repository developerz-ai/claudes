/**
 * The one process-liveness probe behind both stale-file sweeps — the
 * launcher's stale settings files (launch/settings-file.ts) and the doctor's
 * stale probe trees (doctor/checks/wiring.ts). Only ESRCH is dead: EPERM (a
 * pid this process may not signal) and every other probe error count as
 * alive, so a sweep never deletes a file whose owner might be running. The
 * probe never throws — a sweeping process must not crash on a probe.
 */
export function pidIsAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCodeOf(err) !== "ESRCH";
  }
}

/**
 * The errno-shaped `err.code`, when the thrown value carries a string one.
 * The read sits inside the try/catch, so a throwing getter also lands here
 * as undefined instead of escaping the probe.
 */
function errnoCodeOf(err: unknown): string | undefined {
  try {
    if (typeof err === "object" && err !== null) {
      const code = (err as { readonly code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
  } catch {
    // a throwing getter has no readable code
  }
  return undefined;
}
