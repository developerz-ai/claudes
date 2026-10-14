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

/** GET `${baseUrl}/healthz`; resolves the router's version string. */
export async function health(baseUrl: string, fetchImpl: FetchLike): Promise<string> {
  const endpoint = `${baseUrl}/healthz`;
  const res = await request(endpoint, {}, fetchImpl);
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
): Promise<string[]> {
  const endpoint = `${baseUrl}/v1/models`;
  const res = await request(endpoint, { Authorization: `Bearer ${key}` }, fetchImpl);
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
): Promise<Response> {
  try {
    return await fetchImpl(endpoint, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(endpoint, err);
  }
}

function unreachable(endpoint: string, err: unknown): RouterError {
  const name = err instanceof Error ? err.name : "Error";
  if (name === "TimeoutError" || name === "AbortError") {
    return new RouterError(`GET ${endpoint} timed out after ${TIMEOUT_MS / 1000}s`);
  }
  return new RouterError(`could not reach ${endpoint} (${name})`);
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
  if (res.body === null) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      throw new RouterError(`GET ${endpoint} response body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
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

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}
