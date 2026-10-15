import type { Env } from "../config/paths";
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

/** The hosts a loopback router can live on; a proxy must never see their traffic. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/** The value pinned for NO_PROXY/no_proxy when the router is on loopback. */
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * The transport and trust env names the generated settings pin to the
 * launcher's parent env for every router. On an https router, Claude Code
 * merges `env` per key and the --settings file wins, so an HTTPS_PROXY plus
 * NODE_TLS_REJECT_UNAUTHORIZED=0 or NODE_EXTRA_CA_CERTS planted in a user,
 * project or local settings file would hand a proxy a TLS MITM — and the key
 * travels through that TLS. Pinning each name to the parent env's value (or ""
 * when the parent has none) means a settings-file proxy or CA never applies,
 * while the developer's own shell choices still do.
 */
export const TRANSPORT_ENV = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_ENV_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CLAUDE_CODE_CERT_STORE",
] as const;

/**
 * True when the router's base URL points at this machine: a proxy configured
 * in the user's or project's settings must not receive the plaintext key, and
 * loopback traffic never needs one. A URL that does not parse is not loopback.
 */
function baseUrlIsLoopback(baseUrl: string): boolean {
  try {
    return (LOOPBACK_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The loopback NO_PROXY value for one parent setting: the loopback hosts, plus
 * the parent's own entries after a comma when it has any — appending never
 * drops the developer's own no_proxy list.
 */
function loopbackNoProxy(parentValue: string | undefined): string {
  return parentValue === undefined || parentValue === ""
    ? LOOPBACK_NO_PROXY
    : `${LOOPBACK_NO_PROXY},${parentValue}`;
}

/**
 * The generated Claude Code settings, helper-only: the key never enters the
 * session env, `claudes key` serves it to Claude Code through the helper. The
 * credential vars are blanked (harmless, and it stops a leaked personal value
 * from winning over the helper), every provider switch is pinned to "" (Claude
 * Code merges settings env per key, so a switch set in a user or project
 * settings file would otherwise survive this file and reroute the session),
 * every TRANSPORT_ENV name is pinned to the parent env's value (see that
 * constant for why a settings-file proxy or CA must not see the key), the
 * three tier defaults pin every model name to a router-served id (Haiku
 * always pinned, so background work never runs on Opus), and the deny list
 * turns off what the router cannot serve. A loopback router additionally pins
 * NO_PROXY/no_proxy so a settings-file proxy cannot intercept the key.
 */
export function buildSettings(config: Config, self: SelfPaths, parentEnv: Env): Settings {
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
    // Each name carries the parent env's value, or "" when the parent has
    // none — never a value some settings file planted.
    ...Object.fromEntries(TRANSPORT_ENV.map((name) => [name, parentEnv[name] ?? ""])),
  };
  if (config.subagentModel !== undefined) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = config.subagentModel;
  }
  if (config.maxContextTokens !== undefined) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(config.maxContextTokens);
  }
  if (baseUrlIsLoopback(config.baseUrl)) {
    env.NO_PROXY = loopbackNoProxy(parentEnv.NO_PROXY);
    env.no_proxy = loopbackNoProxy(parentEnv.no_proxy);
  }
  return {
    apiKeyHelper: buildKeyHelper(self),
    permissions: { deny: denyRules() },
    env,
  };
}
