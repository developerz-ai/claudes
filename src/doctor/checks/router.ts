import { type Config, keyFragmentOffset } from "../../config/schema";
import {
  errorName,
  type FetchLike,
  health,
  isRouterError,
  type ModelEntry,
  models,
} from "../../router/client";
import { type ModelFamily, TIER_FAMILIES } from "../../tiers";
import type { CheckResult } from "../results";

/** The same budget login's probes get; a healthy router answers far faster. */
const ROUTER_TIMEOUT_MS = 10_000;

/** What a title prints instead of a version that carried key material. */
const WITHHELD_VERSION = "withheld: the router echoed key material";

/** What a title prints instead of an answer that carried key material. */
const WITHHELD_DETAIL = "the answer was withheld (it carried key material)";

export interface RouterCheck {
  readonly results: CheckResult[];
  /** The ids /v1/models served, for the effective-model check; undefined on failure. */
  readonly modelIds: string[] | undefined;
  readonly modelEntries?: readonly ModelEntry[];
}

export interface RouterDeps {
  readonly config: Config;
  readonly profile?: string;
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
  const key = deps.config.key;
  const reloginFix = `run \`claudes login --profile ${deps.profile ?? "default"}\``;
  let version: string;
  try {
    version = await health(base, deps.fetch, timeoutMs);
  } catch (err) {
    return {
      results: [
        {
          status: "FAIL",
          title: `router ${base} failed the health check: ${describe(err, base, key)}`,
          fix: "check the router is running and reachable from this machine",
        },
      ],
      modelIds: undefined,
    };
  }
  // The version is the router's own text and the client checks only its shape,
  // so a router that echoes the key (or a fragment of its body) would put it
  // on screen. Withhold it — the router answered, so the check still PASSes.
  const shownVersion = carriesKeyMaterial(version, key) ? WITHHELD_VERSION : version;
  const results: CheckResult[] = [
    { status: "PASS", title: `router ${base} (version ${shownVersion})` },
  ];

  let entries: ModelEntry[];
  try {
    entries = await models(base, key, deps.fetch, timeoutMs);
  } catch (err) {
    if (isRouterError(err) && (err.status === 401 || err.status === 403)) {
      results.push({
        status: "FAIL",
        title: `the router rejected the key (HTTP ${err.status})`,
        fix: reloginFix,
      });
    } else {
      results.push({
        status: "FAIL",
        title: `could not list the router's models: ${describe(err, base, key)}`,
        fix: "check the router's logs; /healthz works but /v1/models does not",
      });
    }
    return { results, modelIds: undefined };
  }
  const ids = entries.map(({ id }) => id);
  results.push({ status: "PASS", title: `the key lists ${ids.length} models on /v1/models` });
  const served = new Set(ids);
  const pins = deps.config.pins ?? deps.config.tiers;
  const missing = [...TIER_FAMILIES, "fable" as const].filter((family) => {
    const pin = pins[family];
    return pin !== undefined && !served.has(pin);
  });
  if (missing.length > 0) {
    results.push({
      status: "WARN",
      title: `pinned ${pluralTiers(missing)} not served by the router: ${missing
        .map((family) => `${family}=${pins[family]}`)
        .join(", ")}`,
      fix: reloginFix,
    });
  } else {
    results.push({ status: "PASS", title: "every pinned tier is served by the router" });
  }
  return { results, modelIds: ids, modelEntries: entries };
}

/**
 * True when `text` carries an 8-character window of the key's body. The shared
 * rule (`keyFragmentOffset`, the one implementation of the window rule) decides,
 * and this gate stays window-ONLY: the extra bare-`mar_live_`-prefix rule is the
 * request-id gate's alone (src/doctor/checks/live.ts), because scrubbed output
 * legitimately keeps that prefix and withholding it would change verdicts here.
 */
function carriesKeyMaterial(text: string, key: string): boolean {
  return keyFragmentOffset(text, key) !== undefined;
}

/**
 * The router error's own scrubbed message; anything else is named by class
 * only. A class-shaped `err.name` is still the caller's text, so it is
 * withheld when it carries key material.
 */
function describe(err: unknown, base: string, key: string): string {
  const text = isRouterError(err) ? err.message : `could not reach ${base} (${errorName(err)})`;
  return carriesKeyMaterial(text, key) ? WITHHELD_DETAIL : text;
}

function pluralTiers(families: readonly ModelFamily[]): string {
  return families.length === 1 ? "tier is" : "tiers are";
}
