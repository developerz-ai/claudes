import type { Env } from "../config/paths";
import { PROVIDER_SWITCHES } from "./provider-switches";

/**
 * Env names the child must never inherit: anything that could make Claude Code
 * authenticate somewhere other than the router — leftover personal Anthropic
 * keys, a claude.ai OAuth token, a provider switch, or the Bedrock bearer
 * credential. The list adapts the router's own strip list semantics (multi-ai-router
 * `apps/api/src/providers/claude-sdk/env.ts`) to the launcher's setting: it is
 * copied, not imported, and deliberately narrower. Generic AWS_*, GOOGLE_* and
 * AZURE_* names are inert without a provider switch, and stripping them would
 * break the developer's own aws, gcloud and terraform, so they survive; the
 * whole CLAUDE_CODE_USE_ prefix is not stripped either, because it also holds
 * benign toggles such as CLAUDE_CODE_USE_POWERSHELL_TOOL — only the switch
 * names on the explicit list go.
 */
const STRIPPED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_OAUTH_"] as const;

const STRIPPED_ENV_NAMES: readonly string[] = [
  // The one Bedrock-only credential outside the namespaces above.
  "AWS_BEARER_TOKEN_BEDROCK",
  ...PROVIDER_SWITCHES,
];

export function isStripped(name: string): boolean {
  return (
    STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    STRIPPED_ENV_NAMES.includes(name)
  );
}

/**
 * The env for the `claude` child: the developer's environment (PATH, SSH
 * agent, EDITOR, git variables, their own cloud tooling credentials) minus
 * everything stripped above. Helper-only credential mode: this function never
 * adds a token — the key travels only through `apiKeyHelper` reading `claudes
 * key`, never through the session env.
 */
export function buildChildEnv(parentEnv: Env): Env {
  const child: Env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined || isStripped(name)) {
      continue;
    }
    child[name] = value;
  }
  return child;
}
