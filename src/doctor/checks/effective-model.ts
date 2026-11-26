import { type Config, keyFragmentOffset } from "../../config/schema";
import type { Catalog } from "../../launch/catalog";
import type { SessionModel } from "../../launch/session-model";
import { scrub } from "../../router/errors";
import type { CheckResult } from "../results";

export function checkEffectiveModel(
  config: Config,
  catalog: Catalog,
  model: SessionModel,
  profile = "default",
): CheckResult[] {
  const show = (value: string): string =>
    keyFragmentOffset(value, config.key) === undefined ? scrub(value) : "(withheld)";
  const parts = [`model=${show(model.launchId ?? catalog.tiers.opus)}`];
  if (config.subagentModel !== undefined) {
    parts.push(`subagentModel=${show(config.subagentModel)}`);
  }
  parts.push(
    model.window === undefined
      ? "context window unknown"
      : `context window ${model.window.tokens} tokens (${model.window.source})`,
  );
  const results: CheckResult[] = [
    { status: "PASS", title: `effective models: ${parts.join(", ")}` },
  ];
  if (
    config.subagentModel !== undefined &&
    catalog.entries.size > 0 &&
    !catalog.entries.has(config.subagentModel)
  ) {
    results.push({
      status: "WARN",
      title: "the router does not list the configured subagent model",
      fix: `check the available models for profile ${show(profile)} and update its subagent model`,
    });
  }
  return results;
}
