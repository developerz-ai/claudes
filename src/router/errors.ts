/**
 * The router-facing error vocabulary shared by the client and the login flow:
 * the error type with its trap-safe type test, key scrubbing and the one
 * error-naming rule. Underlying fetch failures can quote the offending header
 * value verbatim ("…Bearer mar_live_… is an invalid header value"), so no
 * `err.message` is ever interpolated into anything user-facing; errors are
 * named by shape, and everything else passes through `scrub` as a second line
 * of defence.
 */

/** Reduces anything that looks like a router key to its bare prefix. */
export function scrub(text: string): string {
  // The run also stops at ")": a key embedded in a longer token (a hostile
  // class-shaped err.name like `Xmar_live_…`) must not eat the closing
  // parenthesis of the parenthetical it was printed in.
  return text.replace(/mar_live_[^\s)]*/g, "mar_live_…");
}

export class RouterError extends Error {
  readonly status: number | undefined;
  /** True when the router was unreachable because the request timed out. */
  readonly timedOut: boolean;
  /**
   * The errno of the TLS certificate-verification failure, when the router's
   * TLS certificate itself failed verification — the code that picks the
   * launcher's TLS note (an expired cert and a host-name mismatch each carry
   * their own).
   */
  readonly tlsVerifyCode: string | undefined;

  constructor(
    message: string,
    status?: number,
    timedOut: boolean = false,
    tlsVerifyCode: string | undefined = undefined,
  ) {
    super(scrub(message));
    this.name = "RouterError";
    this.status = status;
    this.timedOut = timedOut;
    this.tlsVerifyCode = tlsVerifyCode;
  }
}

/**
 * The trap-safe `instanceof` for RouterError, shared by every caller: an
 * exotic object (a proxy whose getPrototypeOf trap throws) reads as "not a
 * RouterError" instead of escaping the check raw.
 */
export function isRouterError(err: unknown): err is RouterError {
  try {
    return err instanceof RouterError;
  } catch {
    return false;
  }
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
