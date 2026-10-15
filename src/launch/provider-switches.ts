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
] as const;

export type ProviderSwitch = (typeof PROVIDER_SWITCHES)[number];

/**
 * The first switch (in PROVIDER_SWITCHES order) set to a truthy value: anything
 * except unset, "", "0" or "false", compared case-insensitively. Returns
 * undefined when every switch is off.
 */
export function firstSetProviderSwitch(env: Env): ProviderSwitch | undefined {
  for (const name of PROVIDER_SWITCHES) {
    const value = env[name];
    if (value === undefined) {
      continue;
    }
    const normalized = value.toLowerCase();
    if (normalized !== "" && normalized !== "0" && normalized !== "false") {
      return name;
    }
  }
  return undefined;
}
