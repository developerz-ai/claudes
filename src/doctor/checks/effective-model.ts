import type { Config } from "../../config/schema";
import type { CheckResult } from "../results";

export interface EffectiveModelDeps {
  readonly config: Config;
  /** What GET /v1/models served for this key; the router check's output. */
  readonly modelIds: readonly string[];
}

/**
 * Check 7: the model and advisorModel Claude Code will actually use under the
 * generated settings. The settings pin one id per family, and Claude Code
 * starts sessions on the Sonnet family while the advisor (and other background
 * work) runs on the Haiku family — so those two pins are the effective models,
 * plus the configured subagent model when there is one. WARN when the key's
 * own /v1/models does not serve one: the request would 404 mid-session.
 */
export function checkEffectiveModel(deps: EffectiveModelDeps): CheckResult[] {
  const { config } = deps;
  const served = new Set(deps.modelIds);
  const effective: { readonly role: string; readonly id: string }[] = [
    { role: "model", id: config.tiers.sonnet },
    { role: "advisorModel", id: config.tiers.haiku },
  ];
  if (config.subagentModel !== undefined) {
    effective.push({ role: "subagentModel", id: config.subagentModel });
  }
  const missing = effective.filter((entry) => !served.has(entry.id));
  if (missing.length > 0) {
    return [
      {
        status: "WARN",
        title: `the router does not serve ${missing.map((entry) => `${entry.role}=${entry.id}`).join(", ")}`,
        fix: "re-run `claudes login` (or pass a --sonnet/--haiku override) so every effective model is served",
      },
    ];
  }
  return [
    {
      status: "PASS",
      title: `effective models: ${effective.map((entry) => `${entry.role}=${entry.id}`).join(", ")}`,
    },
  ];
}
