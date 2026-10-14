/**
 * Client for the self-hosted, Anthropic-compatible router. The router key only
 * ever travels in the Authorization header — never in a URL, error message, or
 * log — so every error here names the endpoint and status code, nothing else.
 */
export class RouterError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "RouterError";
    this.status = status;
  }
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

const TIMEOUT_MS = 10_000;

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
  return (body as { version: string }).version;
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
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(endpoint, err);
  }
  return res;
}

function unreachable(endpoint: string, err: unknown): RouterError {
  const name = err instanceof Error ? err.name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return new RouterError(`GET ${endpoint} timed out after ${TIMEOUT_MS / 1000}s`);
  }
  return new RouterError(
    `could not reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

async function parseJson(endpoint: string, res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new RouterError(`GET ${endpoint} returned a non-JSON body`);
  }
}
