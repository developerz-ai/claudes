import type { Config } from "../../config/schema";
import { errorName } from "../../router/errors";
import type { CheckResult } from "../results";

/** One tiny request through the real router; the same budget as login's probes. */
const LIVE_TIMEOUT_MS = 10_000;

/**
 * A fetch that can POST: the router client's FetchLike is GET-shaped (the
 * launcher never POSTs), so doctor's one live request widens it by exactly
 * `method` and `body`. The real global fetch satisfies this shape.
 */
export type PostFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface LiveDeps {
  readonly config: Config;
  readonly fetch: PostFetch;
  readonly timeoutMs?: number;
}

/** Header names a router may use for the request id, in the order tried. */
const REQUEST_ID_HEADERS = ["x-request-id", "request-id"] as const;

/** A request id is opaque short machine text; anything else is not printed. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;

/**
 * Check 6 (`--live` only): exactly one POST /v1/messages with max_tokens 1 on
 * the Haiku tier, through the real router with the real key. The only thing
 * reported back is the HTTP status and the router's request id — never the
 * body, which could echo the key, and never an underlying error's text.
 */
export async function checkLive(deps: LiveDeps): Promise<CheckResult> {
  const base = deps.config.baseUrl;
  const endpoint = `${base}/v1/messages`;
  const body = JSON.stringify({
    model: deps.config.tiers.haiku,
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  });
  let res: Response;
  try {
    res = await deps.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.config.key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? LIVE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = errorName(err);
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      status: "FAIL",
      title: `live request: ${
        timedOut
          ? `timed out after ${Math.round((deps.timeoutMs ?? LIVE_TIMEOUT_MS) / 1000)} s`
          : `could not reach ${endpoint} (${name})`
      }`,
      fix: "check the router is running and reachable from this machine",
    };
  }
  if (res.status !== 200) {
    const requestId = requestIdOf(res);
    return {
      status: "FAIL",
      title: `live request: POST /v1/messages answered HTTP ${res.status}${
        requestId === undefined ? "" : ` (request id ${requestId})`
      }`,
      fix: "check the router's logs",
    };
  }
  const requestId = requestIdOf(res);
  return {
    status: "PASS",
    title: `live request: POST /v1/messages answered HTTP 200${requestId === undefined ? " (no request id header)" : ` (request id ${requestId})`}`,
  };
}

/** The router's request id header, validated for shape; undefined for none. */
function requestIdOf(res: Response): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null && REQUEST_ID_PATTERN.test(value)) {
      return value;
    }
  }
  return undefined;
}
