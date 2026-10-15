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

/** The proxy pairs, by their uppercase name; the twin is its lowercase form. */
const PROXY_PAIR_UPPERS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

/**
 * The transport and trust env names the generated settings ALWAYS emit, pinned
 * to the launcher's parent env — or "" when the parent has none. For these
 * names "" was verified to behave exactly like unset (live, against Claude
 * Code 2.1.300, Node 24 and Bun 1.4), so a value planted in a user, project or
 * local settings file can never win: on an https router such a plant plus an
 * HTTPS_PROXY would hand a proxy a TLS MITM, and the key travels through that
 * TLS. The proxy names take their value from the case-pair rule in
 * buildSettings (a proxy set through one case must reach both), not a plain
 * per-name pin.
 */
export const PINNED_TRANSPORT_ENV = [
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
  "CLAUDE_CODE_CERT_STORE",
  // Bun's verbose fetch prints every request — headers included — so a truthy
  // plant would print the router key (x-api-key / Authorization) to stderr.
  "BUN_CONFIG_VERBOSE_FETCH",
] as const;

/**
 * Transport names emitted ONLY when the parent env carries a non-empty value,
 * then pinned to that value — never "". For SSL_CERT_FILE and SSL_CERT_DIR an
 * empty string is NOT unset downstream: Claude Code applies its settings env to
 * every subprocess, and the OpenSSL clients there (python urllib / pip, wget,
 * openssl, ruby) read "" as an empty CA store and fail every HTTPS request
 * with CERTIFICATE_VERIFY_FAILED. Claude Code 2.1.300 does not honour plants
 * of these two from a settings file anyway, so omitting them leaves nothing
 * unpinned.
 */
export const PARENT_ONLY_TRANSPORT_ENV = ["SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

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

/** The parent's value when it is a real setting; both unset and "" are not. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/** The twin of a proxy pair name (HTTP_PROXY ↔ http_proxy); undefined for none. */
function proxyTwinOf(name: string): string | undefined {
  for (const upper of PROXY_PAIR_UPPERS) {
    if (name === upper) {
      return upper.toLowerCase();
    }
    if (name === upper.toLowerCase()) {
      return upper;
    }
  }
  return undefined;
}

/**
 * One proxy name's pinned value: pinned per PAIR, never per name — tools and
 * subprocesses read either case, so a proxy exported through only one must
 * still reach both, and a twin left at "" would let a case-sensitive client
 * slip around the developer's no-proxy intent. Both names set keep their own
 * values; exactly one set pins BOTH to it; neither pins both to "".
 */
function proxyPairValue(name: string, parentEnv: Env): string {
  const twin = proxyTwinOf(name);
  if (twin === undefined) {
    return parentEnv[name] ?? "";
  }
  return nonEmpty(parentEnv[name]) ?? nonEmpty(parentEnv[twin]) ?? "";
}

/** The entries of one parent NO_PROXY value: comma-separated, trimmed, non-empty. */
function noProxyEntries(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The ONE merged NO_PROXY pinned to both names: the parent's uppercase entries
 * first, then its lowercase ones, deduped in order — and on a loopback router
 * the loopback hosts prepended (deduped too), so no settings-file proxy can
 * intercept the key's plaintext hop and the developer's own entries survive.
 */
function mergedNoProxy(parentEnv: Env, loopback: boolean): string {
  const entries = [
    ...(loopback ? LOOPBACK_NO_PROXY.split(",") : []),
    ...noProxyEntries(parentEnv.NO_PROXY),
    ...noProxyEntries(parentEnv.no_proxy),
  ];
  return [...new Set(entries)].join(",");
}

/**
 * The generated Claude Code settings, helper-only: the key never enters the
 * session env, `claudes key` serves it to Claude Code through the helper. The
 * credential vars are blanked (harmless, and it stops a leaked personal value
 * from winning over the helper), every provider switch is pinned to "" (Claude
 * Code merges settings env per key, so a switch set in a user or project
 * settings file would otherwise survive this file and reroute the session),
 * every PINNED_TRANSPORT_ENV name is pinned to the parent env's value — the
 * proxy pairs per pair, NO_PROXY/no_proxy to one merged value — the
 * PARENT_ONLY_TRANSPORT_ENV names are emitted only when the parent sets them,
 * the three tier defaults pin every model name to a router-served id (Haiku
 * always pinned, so background work never runs on Opus), and the deny list
 * turns off what the router cannot serve.
 */
export function buildSettings(config: Config, self: SelfPaths, parentEnv: Env): Settings {
  const loopback = baseUrlIsLoopback(config.baseUrl);
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
    ...Object.fromEntries(
      PINNED_TRANSPORT_ENV.map((name) => [
        name,
        name === "NO_PROXY" || name === "no_proxy"
          ? mergedNoProxy(parentEnv, loopback)
          : proxyPairValue(name, parentEnv),
      ]),
    ),
    // The parent-only names appear just when the parent has a value: their ""
    // is not unset for the OpenSSL clients in the session's subprocesses.
    ...Object.fromEntries(
      PARENT_ONLY_TRANSPORT_ENV.flatMap((name) => {
        const value = nonEmpty(parentEnv[name]);
        return value === undefined ? [] : [[name, value]];
      }),
    ),
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
