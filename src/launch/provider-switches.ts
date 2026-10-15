import type { Env } from "../config/paths";

/**
 * The env names that switch Claude Code to a first-party provider (Bedrock,
 * Vertex, Foundry, …). Claude Code merges `env` from the user and project
 * settings files per key, so a switch set there survives claudes' generated
 * `--settings` file — the session would then send the router key to another
 * base URL. Two layers close that: the generated settings pin every switch to
 * "" (empty is falsy), and `claudes key` refuses to serve the key at all when
 * one is set to a truthy value in its own environment (the helper subprocess
 * inherits the merged settings env, so switches from settings files are caught
 * there too).
 */
export const PROVIDER_SWITCHES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

export type ProviderSwitch = (typeof PROVIDER_SWITCHES)[number];

/** The `CLAUDE_CODE_USE_` prefix every switch — and no benign toggle — carries. */
const USE_PREFIX = "CLAUDE_CODE_USE_";

/**
 * `CLAUDE_CODE_USE_` toggles that do NOT reroute the session: they pick a local
 * implementation of a tool, not another provider. Everything else under the
 * prefix is treated as a switch, known or not.
 */
export const BENIGN_USE_TOGGLES = [
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
] as const;

/** The truthiness rule a switch value follows: "", "0" and "false" are off. */
function isTruthyToggle(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * The first switch (in PROVIDER_SWITCHES order) set to a truthy value: anything
 * except unset, "", "0" or "false", compared case-insensitively. Returns
 * undefined when every switch is off.
 */
export function firstSetProviderSwitch(env: Env): ProviderSwitch | undefined {
  for (const name of PROVIDER_SWITCHES) {
    if (isTruthyToggle(env[name])) {
      return name;
    }
  }
  return undefined;
}

/**
 * The first env name that would reroute the session, for `claudes key`: every
 * known switch first (stable order), then any OTHER `CLAUDE_CODE_USE_` toggle
 * except the benign allowlist, in sorted order. New switch names Claude Code
 * grows are refused too — the list of names is an allowlist, not a blocklist.
 */
export function firstReroutingUseToggle(env: Env): string | undefined {
  const switched = firstSetProviderSwitch(env);
  if (switched !== undefined) {
    return switched;
  }
  const known = PROVIDER_SWITCHES as readonly string[];
  const benign = BENIGN_USE_TOGGLES as readonly string[];
  const others = Object.keys(env)
    .filter(
      (name) => name.startsWith(USE_PREFIX) && !known.includes(name) && !benign.includes(name),
    )
    .sort();
  for (const name of others) {
    if (isTruthyToggle(env[name])) {
      return name;
    }
  }
  return undefined;
}
