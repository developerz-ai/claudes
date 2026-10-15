import type { Config } from "../config/schema";
import { PROVIDER_SWITCHES } from "./provider-switches";
import { denyRules, disabledEnv } from "./unsupported";

/** Where the running claudes lives, so apiKeyHelper can call back into it. */
export interface SelfPaths {
  readonly nodePath: string;
  readonly scriptPath: string;
}

export interface Settings {
  readonly apiKeyHelper: string;
  readonly permissions: { readonly deny: readonly string[] };
  readonly env: Readonly<Record<string, string>>;
}

/** Single-quotes one word for /bin/sh: inside '…' only the quote is special. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The /bin/sh command Claude Code runs to fetch the key on demand:
 * `'<node>' '<claudes>' key`. Both paths are quoted so a claudes installed
 * under a path with spaces or quotes still resolves.
 */
export function buildKeyHelper(self: SelfPaths): string {
  return `${shellQuote(self.nodePath)} ${shellQuote(self.scriptPath)} key`;
}

/**
 * The generated Claude Code settings, helper-only: the key never enters the
 * session env, `claudes key` serves it to Claude Code through the helper. The
 * credential vars are blanked (harmless, and it stops a leaked personal value
 * from winning over the helper), every provider switch is pinned to "" (Claude
 * Code merges settings env per key, so a switch set in a user or project
 * settings file would otherwise survive this file and reroute the session),
 * the three tier defaults pin every model name to a router-served id (Haiku
 * always pinned, so background work never runs on Opus), and the deny list
 * turns off what the router cannot serve.
 */
export function buildSettings(config: Config, self: SelfPaths): Settings {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.tiers.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.tiers.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.tiers.haiku,
    ...disabledEnv(),
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    // Empty string is falsy, so each pin reads as "switch off" to Claude Code.
    ...Object.fromEntries(PROVIDER_SWITCHES.map((name) => [name, ""])),
  };
  if (config.subagentModel !== undefined) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = config.subagentModel;
  }
  if (config.maxContextTokens !== undefined) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(config.maxContextTokens);
  }
  return {
    apiKeyHelper: buildKeyHelper(self),
    permissions: { deny: denyRules() },
    env,
  };
}
