import { Buffer } from "node:buffer";

/**
 * Client for the self-hosted, Anthropic-compatible router. The router key only
 * ever travels in the Authorization header — never in a URL, error message, or
 * log. Underlying fetch failures can quote the offending header value verbatim
 * ("…Bearer mar_live_… is an invalid header value"), so no `err.message` is
 * ever interpolated into an error: endpoints are named, statuses are named,
 * error classes are named by their `err.name`, and everything user-facing is
 * passed through `scrub` as a second line of defence.
 */

/** Reduces anything that looks like a router key to its bare prefix. */
export function scrub(text: string): string {
  return text.replace(/mar_live_\S*/g, "mar_live_…");
}

export class RouterError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(scrub(message));
    this.name = "RouterError";
    this.status = status;
  }
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 ** 20; // 1 MiB is far more than either endpoint returns
const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,64}$/;
/** Errno-looking tokens only (`ECONNREFUSED`, `EAI_AGAIN`); never free text. */
const CAUSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
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

/** GET `${baseUrl}/healthz`; resolves the router's version string. */
export async function health(
  baseUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string> {
  const endpoint = `${baseUrl}/healthz`;
  const res = await request(endpoint, {}, fetchImpl, timeoutMs);
  if (res.status !== 200) {
    throw new RouterError(`GET ${endpoint} failed: HTTP ${res.status}`, res.status);
  }
  const body = await parseJson(endpoint, res);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { version?: unknown }).version !== "string"
  ) {
    throw new RouterError(`GET ${endpoint} returned JSON without a string "version"`);
  }
  const version = (body as { version: string }).version;
  if (!VERSION_PATTERN.test(version)) {
    // The version is printed to the user; never relay raw router bytes.
    throw new RouterError(`GET ${endpoint}: router returned an invalid version string`);
  }
  return version;
}

/** GET `${baseUrl}/v1/models` with the key as a bearer token; resolves the model ids. */
export async function models(
  baseUrl: string,
  key: string,
  fetchImpl: FetchLike,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string[]> {
  const endpoint = `${baseUrl}/v1/models`;
  const res = await request(endpoint, { Authorization: `Bearer ${key}` }, fetchImpl, timeoutMs);
  if (res.status !== 200) {
    throw new RouterError(`GET ${endpoint} failed: HTTP ${res.status}`, res.status);
  }
  const body = await parseJson(endpoint, res);
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { data?: unknown }).data)
  ) {
    throw new RouterError(`GET ${endpoint} returned JSON without a "data" array`);
  }
  const ids: string[] = [];
  for (const entry of (body as { data: unknown[] }).data) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { id?: unknown }).id !== "string"
    ) {
      throw new RouterError(`GET ${endpoint} returned a malformed model entry`);
    }
    ids.push((entry as { id: string }).id);
  }
  return ids;
}

async function request(
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(endpoint, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw unreachable(endpoint, err, timeoutMs);
  }
}

function unreachable(endpoint: string, err: unknown, timeoutMs: number): RouterError {
  const name = errorName(err);
  if (name === "TimeoutError" || name === "AbortError") {
    return new RouterError(`GET ${endpoint} timed out after ${timeoutMs / 1000}s`);
  }
  return new RouterError(`could not reach ${endpoint} (${diagnostic(err)})`);
}

/**
 * The short token in the parentheses of an unreachable-endpoint error. Only
 * machine-readable shapes are eligible — an errno from `err.cause.code`, or a
 * class name — so no underlying message text can reach the user.
 */
function diagnostic(err: unknown): string {
  if (err instanceof Error) {
    // An errno wins: a DNS or TLS failure can mention "redirect" in its text
    // (a hostname, a certificate SAN), and must still be reported by code.
    const code = causeCodeOf(err);
    if (code !== undefined) {
      return code;
    }
    // fetch(…, {redirect: "error"}): Node rejects with TypeError("fetch
    // failed") whose code-less cause is exactly "unexpected redirect"; Bun
    // puts a fixed phrase at the start of err.message. Matched exactly, never
    // printed.
    if (err instanceof TypeError && saysRedirect(err)) {
      return "refused a redirect";
    }
  }
  return errorName(err);
}

/** True only for the runtimes' exact refused-redirect shapes; never throws. */
function saysRedirect(err: Error): boolean {
  try {
    if (causeMessageOf(err) === "unexpected redirect") {
      return true;
    }
    return /^(UnexpectedRedirect\b|redirect mode is set to error\b)/.test(err.message);
  } catch {
    return false;
  }
}

/** Reads `err.cause` defensively: a throwing getter must not escape. */
function causeOf(err: Error): unknown {
  try {
    return (err as { readonly cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

/** The cause's message, when the cause is an Error; never throws. */
function causeMessageOf(err: Error): string {
  const cause = causeOf(err);
  if (!(cause instanceof Error)) {
    return "";
  }
  try {
    return cause.message;
  } catch {
    return "";
  }
}

/** The cause's errno-looking code, when it has one; never throws. */
function causeCodeOf(err: Error): string | undefined {
  const cause = causeOf(err);
  if (cause === null || typeof cause !== "object") {
    return undefined;
  }
  try {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === "string" && CAUSE_CODE_PATTERN.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

async function parseJson(endpoint: string, res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await readBodyCapped(endpoint, res);
  } catch (err) {
    if (err instanceof RouterError) {
      throw err;
    }
    throw new RouterError(`GET ${endpoint} body could not be read (${errorName(err)})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RouterError(`GET ${endpoint} returned a non-JSON body`);
  }
}

/** Reads the response body, refusing anything larger than MAX_BODY_BYTES. */
async function readBodyCapped(endpoint: string, res: Response): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      throw new RouterError(`GET ${endpoint} response body exceeds ${MAX_BODY_BYTES} bytes`);
    }
  }
  // Only null-body statuses (204/205/304) carry a null body, and those never
  // reach here — the 200 gate above already rejected them — so a null body
  // from an off-spec fetch is simply empty, not a second code path.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {
        // the connection is being discarded either way
      });
      throw new RouterError(`GET ${endpoint} response body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
