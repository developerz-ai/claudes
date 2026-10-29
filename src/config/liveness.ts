/**
 * Process liveness for the two stale-entry sweeps: the launcher's per-launch
 * settings files (launch/settings-file.ts) and the doctor probe's throwaway
 * trees (doctor/checks/wiring.ts). Both remove an entry only when its pid is
 * dead, and both must reach the same verdict from the same probe — hence one
 * shared contract here instead of a private copy in each sweep.
 */

/**
 * True when `pid` names a process this one can probe; false only when the
 * kernel answered that no such process exists (ESRCH). A pid this process
 * may not signal — EPERM, like pid 1 probed as non-root — still means alive:
 * the inability to signal is not evidence of death. Liveness is judged in
 * this process's own pid namespace, so a config directory shared across
 * containers can see another namespace's live process as dead.
 */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCodeOf(err) !== "ESRCH";
  }
}

/** The errno-shaped `err.code`, when the thrown value carries a string one. */
function errCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}
