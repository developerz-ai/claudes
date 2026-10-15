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

/**
 * Env names that hand Claude Code's provider/endpoint/auth configuration to a
 * managing host process: with the first truthy, or the second set to any
 * non-empty value, Claude Code ignores the generated settings file's provider,
 * endpoint and auth keys outright — the session would silently skip the router
 * while appearing to work. The launcher refuses up front. A plant of these in
 * some other settings file is itself ignored by Claude Code, so the key helper
 * needs no matching check.
 */
export const HOST_MANAGED_ENV = [
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
] as const;

export type HostManagedEnvName = (typeof HOST_MANAGED_ENV)[number];

/**
 * The first host-managed name set in `env`, or undefined when the parent env
 * manages nothing. PROVIDER_MANAGED_BY_HOST is a flag, so only a truthy value
 * counts; HOST_AUTH_ENV_VAR carries the NAME of the env var holding the host's
 * credential, so any non-empty value counts — "0" and "false" included.
 */
export function firstHostManagedEnv(env: Env): HostManagedEnvName | undefined {
  if (isTruthyToggle(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";
  }
  const authEnvVar = env.CLAUDE_CODE_HOST_AUTH_ENV_VAR;
  if (authEnvVar !== undefined && authEnvVar !== "") {
    return "CLAUDE_CODE_HOST_AUTH_ENV_VAR";
  }
  return undefined;
}

/** The `CLAUDE_CODE_USE_` prefix shared by switches and benign toggles alike. */
const USE_PREFIX = "CLAUDE_CODE_USE_";

/**
 * `CLAUDE_CODE_USE_` toggles that do NOT reroute the session: they pick a local
 * implementation of a tool, not another provider. Everything else under the
 * prefix is treated as a switch, known or not. CLAUDE_CODE_USE_CCR_V2 is
 * deliberately NOT on this list: it is a remote-session transport toggle, and
 * an unknown meaning is exactly why it must fail closed rather than be
 * allowlisted on a guess.
 */
export const BENIGN_USE_TOGGLES = [
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
] as const;

/**
 * The truthiness rule env toggles follow: anything but unset, "", "0" and
 * "false" is on, compared case-insensitively. Shared by the provider switches,
 * the host-managed flags and the launcher's verbose-fetch refusal.
 */
export function isTruthyToggle(value: string | undefined): boolean {
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
 * The `CLAUDE_CODE_USE_` names that are neither a known switch nor a benign
 * toggle, in sorted order: exactly the names whose meaning claudes cannot
 * account for, so they are treated as switches, known or not.
 */
function unknownUseToggleNames(env: Env): string[] {
  const known = PROVIDER_SWITCHES as readonly string[];
  const benign = BENIGN_USE_TOGGLES as readonly string[];
  return Object.keys(env)
    .filter(
      (name) => name.startsWith(USE_PREFIX) && !known.includes(name) && !benign.includes(name),
    )
    .sort();
}

/** The first of `names` set to a truthy value, in the order given. */
function firstTruthy(env: Env, names: readonly string[]): string | undefined {
  for (const name of names) {
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
  return firstSetProviderSwitch(env) ?? firstTruthy(env, unknownUseToggleNames(env));
}

/**
 * The first rerouting toggle that is NOT a known switch, for the launcher's
 * early refusal: a known switch is stripped from the child env and pinned to ""
 * in the generated settings, so it is harmless at launch; anything else under
 * the prefix reaches the child unstripped and un-pinned, and the key helper
 * would refuse mid-session — so the launcher refuses up front instead.
 */
export function firstUnknownReroutingUseToggle(env: Env): string | undefined {
  return firstTruthy(env, unknownUseToggleNames(env));
}
