import { ROUTER_KEY_PREFIX } from "../config/schema";

/**
 * The router-facing error vocabulary shared by the client and the login flow:
 * the error type with its trap-safe type test, key scrubbing and the one
 * error-naming rule. Underlying fetch failures can quote the offending header
 * value verbatim (a "Bearer <key>" rejected as an invalid header value), so no
 * `err.message` is ever interpolated into anything user-facing; errors are
 * named by shape, and everything else passes through `scrub` as a second line
 * of defence.
 */

/** Escapes the regex metacharacters of a literal, so the prefix matches as text. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The key-shaped run for a prefix: the prefix as literal text, then everything
 * up to whitespace or a closing parenthesis.
 */
function keyShaped(prefix: string): RegExp {
  return new RegExp(`${escapeRegExp(prefix)}[^\\s)]*`, "g");
}

/**
 * Reduces anything that looks like a router key to its bare prefix, for a
 * given prefix.
 *
 * The seam the prefix guards are pinned through: the canonical prefix carries
 * no regex metacharacter and no "$", so the literal matching and the literal
 * replacement it relies on are only observable with a prefix that does.
 */
export function scrubWithPrefix(prefix: string, text: string): string {
  // The run also stops at ")": a key embedded in a longer token (a hostile
  // class-shaped err.name like `X<key>…`) must not eat the closing
  // parenthesis of the parenthetical it was printed in.
  //
  // The replacement is a function, not a string: a "$" inside the prefix
  // would otherwise be read as a replacement pattern.
  return text.replace(keyShaped(prefix), () => `${prefix}…`);
}

/**
 * Reduces anything that looks like a router key to its bare prefix. Built
 * from the prefix the config accepts, so the shape that is redacted can never
 * drift from the shape that is issued.
 */
export function scrub(text: string): string {
  return scrubWithPrefix(ROUTER_KEY_PREFIX, text);
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
  /**
   * True when the router answered /healthz but reported no usable version:
   * the probe succeeded, the payload did not. A different failure from an
   * unreachable router (the launcher refuses it differently), and never a
   * reason to relay the version itself — it can carry key material.
   */
  readonly invalidVersion: boolean;

  constructor(
    message: string,
    status?: number,
    timedOut: boolean = false,
    tlsVerifyCode: string | undefined = undefined,
    invalidVersion: boolean = false,
  ) {
    super(scrub(message));
    this.name = "RouterError";
    this.status = status;
    this.timedOut = timedOut;
    this.tlsVerifyCode = tlsVerifyCode;
    this.invalidVersion = invalidVersion;
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
