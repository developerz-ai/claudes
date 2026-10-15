import type { Config } from "../../config/schema";
import { errorName, type FetchLike, health, models, RouterError } from "../../router/client";
import { TIER_FAMILIES, type TierName } from "../../tiers";
import type { CheckResult } from "../results";

/** The same budget login's probes get; a healthy router answers far faster. */
const ROUTER_TIMEOUT_MS = 10_000;

const RELOGIN_FIX = "re-run `claudes login`";

export interface RouterCheck {
  readonly results: CheckResult[];
  /** The ids /v1/models served, for the effective-model check; undefined on failure. */
  readonly modelIds: string[] | undefined;
}

export interface RouterDeps {
  readonly config: Config;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Check 3: the router answers /healthz with a version, accepts the key on
 * /v1/models, and serves every pinned tier. Same client, same scrubbed errors,
 * as login and the launcher's pre-flight.
 */
export async function checkRouter(deps: RouterDeps): Promise<RouterCheck> {
  const timeoutMs = deps.timeoutMs ?? ROUTER_TIMEOUT_MS;
  const base = deps.config.baseUrl;
  let version: string;
  try {
    version = await health(base, deps.fetch, timeoutMs);
  } catch (err) {
    return {
      results: [
        {
          status: "FAIL",
          title: `router ${base} failed the health check: ${describe(err, base)}`,
          fix: "check the router is running and reachable from this machine",
        },
      ],
      modelIds: undefined,
    };
  }
  const results: CheckResult[] = [{ status: "PASS", title: `router ${base} (version ${version})` }];

  let ids: string[];
  try {
    ids = await models(base, deps.config.key, deps.fetch, timeoutMs);
  } catch (err) {
    if (err instanceof RouterError && (err.status === 401 || err.status === 403)) {
      results.push({
        status: "FAIL",
        title: `the router rejected the key (HTTP ${err.status})`,
        fix: RELOGIN_FIX,
      });
    } else {
      results.push({
        status: "FAIL",
        title: `could not list the router's models: ${describe(err, base)}`,
        fix: "check the router's logs; /healthz works but /v1/models does not",
      });
    }
    return { results, modelIds: undefined };
  }
  results.push({ status: "PASS", title: `the key lists ${ids.length} models on /v1/models` });

  const served = new Set(ids);
  const missing = TIER_FAMILIES.filter((family) => !served.has(deps.config.tiers[family]));
  if (missing.length > 0) {
    results.push({
      status: "WARN",
      title: `pinned ${pluralTiers(missing)} not served by the router: ${missing
        .map((family) => `${family}=${deps.config.tiers[family]}`)
        .join(", ")}`,
      fix: RELOGIN_FIX,
    });
  } else {
    results.push({ status: "PASS", title: "every pinned tier is served by the router" });
  }
  return { results, modelIds: ids };
}

/** The router error's own scrubbed message; anything else is named by class only. */
function describe(err: unknown, base: string): string {
  return err instanceof RouterError ? err.message : `could not reach ${base} (${errorName(err)})`;
}

function pluralTiers(families: readonly TierName[]): string {
  return families.length === 1 ? "tier is" : "tiers are";
}
