/**
 * The router-facing error vocabulary shared by the client and the login flow:
 * key scrubbing and the one error-naming rule. Underlying fetch failures can
 * quote the offending header value verbatim ("…Bearer mar_live_… is an invalid
 * header value"), so no `err.message` is ever interpolated into anything
 * user-facing; errors are named by shape, and everything else passes through
 * `scrub` as a second line of defence.
 */

/** Reduces anything that looks like a router key to its bare prefix. */
export function scrub(text: string): string {
  return text.replace(/mar_live_\S*/g, "mar_live_…");
}

/** Class-shaped names only (`TypeError`, `TimeoutError`); never free text. */
const ERROR_NAME_PATTERN = /^[A-Z][A-Za-z0-9_]{0,63}$/;

/**
 * The single error-name helper (login and client share it): `err.name` when it
 * is a class-shaped token, "Error" for anything else — a name that is missing,
 * not a string, or produced by a throwing getter is never printed.
 */
export function errorName(err: unknown): string {
  try {
    if (err instanceof Error) {
      const name = err.name;
      if (typeof name === "string" && ERROR_NAME_PATTERN.test(name)) {
        return name;
      }
    }
  } catch {
    // an exotic object (throwing getter or prototype trap) is not printable
  }
  return "Error";
}
