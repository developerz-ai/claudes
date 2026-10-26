import type { Env } from "../config/paths";
import { type FetchLike, health, RouterError, TLS_VERIFY_CODES } from "../router/client";

export const ROUTER_UNREACHABLE_MESSAGE =
  "router unreachable: run `claudes doctor`, or use plain `claude` with your own login (usage won't be attributed)";
/**
 * The refusal for a router that answered the pre-launch check but reported
 * no usable version: a different failure from an unreachable router, with
 * the same exit code and no notes (the probe answered, so the proxy, TLS and
 * timeout hints do not apply).
 */
export const ROUTER_INVALID_VERSION_MESSAGE =
  "router answered the pre-launch check with an invalid version: the configured router URL does not point at a router claudes can use — run `claudes doctor`";
export const PROXY_NOTE_MESSAGE =
  "note: claudes' router check does not use HTTP(S)_PROXY; set NODE_USE_ENV_PROXY=1 if your network needs a proxy";
export const TLS_VERIFY_NOTE_MESSAGE =
  "note: the router's TLS certificate was not trusted; if its CA is in your system store set NODE_USE_SYSTEM_CA=1 (NODE_USE_SYSTEM_CA needs Node 22.19 or 24.6 or newer), or point NODE_EXTRA_CA_CERTS at it";
export const TLS_EXPIRED_NOTE_MESSAGE = "note: the router's TLS certificate has expired";
export const TLS_NOT_YET_VALID_NOTE_MESSAGE =
  "note: the router's TLS certificate is not valid yet; check this machine's clock";
export const TLS_HOSTNAME_NOTE_MESSAGE =
  "note: the router's TLS certificate does not match its host name";

/**
 * The note per certificate-verification errno. Expired, not-yet-valid and a
 * host-name mismatch each say so in their own words (no CA store fixes them);
 * every other code in the client's TLS_VERIFY_CODES means "trust this CA".
 */
const TLS_NOTE_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["CERT_HAS_EXPIRED", TLS_EXPIRED_NOTE_MESSAGE],
  ["CERT_NOT_YET_VALID", TLS_NOT_YET_VALID_NOTE_MESSAGE],
  ["ERR_TLS_CERT_ALTNAME_INVALID", TLS_HOSTNAME_NOTE_MESSAGE],
]);

/**
 * The TLS note for a certificate-verification errno, when the failure was
 * one; anything else — including no errno at all — earns no note.
 */
export function tlsVerifyNote(code: string | undefined): string | undefined {
  if (code === undefined || !TLS_VERIFY_CODES.has(code)) {
    return undefined;
  }
  return TLS_NOTE_OVERRIDES.get(code) ?? TLS_VERIFY_NOTE_MESSAGE;
}
export const PREFLIGHT_TIMEOUT_NOTE_MESSAGE =
  "note: the router check timed out; set CLAUDES_PREFLIGHT_TIMEOUT_MS (milliseconds) to wait longer";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 1_500;
/** The largest accepted CLAUDES_PREFLIGHT_TIMEOUT_MS: a signed 32-bit integer. */
const MAX_PREFLIGHT_TIMEOUT_MS = 2_147_483_647;

/**
 * The router pre-flight timeout in milliseconds, from
 * `CLAUDES_PREFLIGHT_TIMEOUT_MS`; anything but an integer in 1..2147483647
 * (unset, empty, non-numeric, fractional, zero, negative, out of range) is
 * ignored in favor of the default.
 */
export function preflightTimeoutMs(env: Env): number {
  const raw = env.CLAUDES_PREFLIGHT_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_PREFLIGHT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PREFLIGHT_TIMEOUT_MS
    ? parsed
    : DEFAULT_PREFLIGHT_TIMEOUT_MS;
}

/**
 * One pre-flight attempt, retried exactly once when — and only when — the
 * router attempt timed out: a slow first probe (cold DNS, a just-woken
 * laptop) deserves a second chance, a hard refusal or connection error does
 * not. A second failure of any kind propagates.
 */
export async function preflight(
  baseUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<void> {
  try {
    await health(baseUrl, fetchImpl, timeoutMs);
  } catch (err) {
    if (!(err instanceof RouterError) || !err.timedOut) {
      throw err;
    }
    await health(baseUrl, fetchImpl, timeoutMs);
  }
}

/**
 * True when a proxy is set but Node's env-proxy opt-in is not: the pre-flight
 * would then bypass the developer's proxy and fail for that reason alone,
 * which deserves its own hint next to the unreachable message. Both cases of
 * each name count: tools export uppercase or lowercase. ALL_PROXY/all_proxy
 * are deliberately absent — NODE_USE_ENV_PROXY does not honour them.
 */
export function proxyNoteNeeded(env: Env): boolean {
  const proxySet = [env.HTTPS_PROXY, env.HTTP_PROXY, env.https_proxy, env.http_proxy].some(isSet);
  return proxySet && !isSet(env.NODE_USE_ENV_PROXY);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
