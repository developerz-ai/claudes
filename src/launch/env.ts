import type { Env } from "../config/paths";

/**
 * Env names the child must never inherit: anything that could make Claude Code
 * authenticate somewhere other than the router — leftover personal Anthropic
 * keys, a claude.ai OAuth token, or Bedrock/Vertex/Foundry credentials. The
 * list mirrors the router's own strip list semantics (multi-ai-router
 * `apps/api/src/providers/claude-sdk/env.ts`, `STRIPPED_ENV_PREFIXES` and
 * `STRIPPED_ENV_NAMES`); it is copied, not imported.
 */
export const STRIPPED_ENV_PREFIXES = [
  // Personal Anthropic credentials and settings, including the Bedrock and
  // Vertex base URLs Claude Code reads from this namespace.
  "ANTHROPIC_",
  // Provider switches: CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY would route
  // the session away from the router entirely.
  "CLAUDE_CODE_USE_",
  "CLAUDE_BEDROCK_",
  "CLAUDE_CODE_VERTEX_",
  "AZURE_AI_FOUNDRY_",
] as const;

export const STRIPPED_ENV_NAMES = [
  // A claude.ai OAuth token would be sent to the router as-is.
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Bedrock credentials living outside the ANTHROPIC_/CLAUDE_ namespaces; the
  // region vars go too, because SigV4 for Bedrock needs them to succeed.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  // Vertex (GCP) and Foundry (Azure) credential material.
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
] as const;

export function isStripped(name: string): boolean {
  return (
    STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (STRIPPED_ENV_NAMES as readonly string[]).includes(name)
  );
}

/**
 * The env for the `claude` child: the developer's environment (PATH, SSH
 * agent, EDITOR, git variables) minus everything stripped above. Helper-only
 * credential mode: this function never adds a token — the key travels only
 * through `apiKeyHelper` reading `claudes key`, never through the session env.
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
