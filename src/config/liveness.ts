/**
 * The one liveness probe the config sweeps share. A sweep removes what a dead
 * process left behind, so a wrong "dead" answer deletes a live run's files.
 * The kernel is the only authority: kill(pid, 0) asks it whether the pid
 * exists, and only ESRCH — no such process — means dead. EPERM means the
 * process exists but belongs to another user, and every other outcome (any
 * other errno, a thrown value with no errno-shaped code) means this process
 * could not answer, which is not the same as "gone". Only a definite ESRCH
 * retires a pid.
 */

/** The probe seam: `kill(pid, 0)` asks the kernel about a pid, it does not signal it. */
export type KillProbe = (pid: number, signal: 0) => void;

/**
 * True when `pid` names a process this one can see. The optional `kill` is a
 * test seam: it makes the branches the kernel decides by privilege (EPERM)
 * and the branches a fault can produce (any other errno) reachable without
 * root and without a race; production callers pass only the pid.
 */
export function pidIsAlive(pid: number, kill?: KillProbe): boolean {
  try {
    (kill ?? defaultKill)(pid, 0);
    return true;
  } catch (err) {
    return errCodeOf(err) !== "ESRCH";
  }
}

/** The kernel's own answer: signal 0 probes a pid without touching it. */
const defaultKill: KillProbe = (pid, signal) => {
  process.kill(pid, signal);
};

/** The errno-shaped `code` of a thrown value, when it carries a string one. */
function errCodeOf(err: unknown): string | undefined {
  try {
    if (typeof err === "object" && err !== null) {
      const code = (err as { readonly code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
  } catch {
    // a throwing getter has no code to read: the probe could not answer
  }
  return undefined;
}
