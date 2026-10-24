import { ROUTER_KEY_PREFIX } from "../config/schema";

export type ArgvResult =
  | { readonly ok: true; readonly argv: string[] }
  | { readonly ok: false; readonly exitCode: 64; readonly message: string };

/** Claude Code accepts the bare family name for --model; the router wants it. */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "claude-opus": "opus",
  "claude-sonnet": "sonnet",
  "claude-haiku": "haiku",
};

/** The `[1m]` context-window suffix Claude Code accepts on a model name. */
const MODEL_SUFFIX = "[1m]";

/**
 * A router key as it would land on a command line: the prefix followed by at
 * least 8 key characters (the real keys have 32; the margin catches a pasted
 * key even when its tail was cut off). Deliberately looser than the config's
 * own pattern, and matched as a shape so ordinary prose that merely names the
 * prefix — "explain the mar_live_ prefix" — is not refused.
 */
const KEY_ON_ARGV = new RegExp(`${ROUTER_KEY_PREFIX}[A-Za-z0-9_-]{8,}`);

function looksLikeRouterKey(token: string | undefined): boolean {
  return token !== undefined && KEY_ON_ARGV.test(token);
}

/** The alias table's own entry for `value`, ignoring the prototype chain. */
function aliasFor(value: string): string | undefined {
  return Object.hasOwn(MODEL_ALIASES, value) ? MODEL_ALIASES[value] : undefined;
}

/**
 * Normalises a --model value: a known alias maps to its bare family name,
 * keeping an optional `[1m]` suffix attached. Anything else — including
 * prototype-born names like `toString` or `__proto__`, which are not own
 * properties of the alias table — passes through unchanged.
 */
function mapModelValue(value: string): string {
  const alias = aliasFor(value);
  if (alias !== undefined) {
    return alias;
  }
  if (value.endsWith(MODEL_SUFFIX)) {
    const base = aliasFor(value.slice(0, -MODEL_SUFFIX.length));
    if (base !== undefined) {
      return `${base}${MODEL_SUFFIX}`;
    }
  }
  return value;
}

/**
 * Builds the `claude` argv: the generated settings file first, then the user's
 * arguments. `--model claude-opus|claude-sonnet|claude-haiku` (with an optional
 * `[1m]`) normalises to the bare family name. A user `--settings` or `--key` is
 * refused, as is any argument containing a router key — and no refused value is
 * ever echoed back. Everything after a `--` terminator is positional prompt
 * text, so the rewriting stops there — but the key-shape refusal does not: a
 * router-key-shaped token after `--` is still refused.
 */
export function buildArgv(userArgs: readonly string[], settingsPath: string): ArgvResult {
  const argv: string[] = [];
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i] ?? "";
    if (arg === "--") {
      // Everything after the terminator is positional prompt text, so the
      // rewriting stops — but a pasted key still leaks through shell history
      // and process listings, so the key-shape refusal still runs there.
      for (const rest of userArgs.slice(i + 1)) {
        if (looksLikeRouterKey(rest)) {
          return refusedKey();
        }
      }
      argv.push(...userArgs.slice(i));
      return { ok: true, argv: ["--settings", settingsPath, ...argv] };
    }
    // The scan runs on the whole token, whatever position a pasted key lands in.
    if (looksLikeRouterKey(arg)) {
      return refusedKey();
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name === "--settings") {
      return refused(
        "claudes: --settings is not supported — claudes writes its own settings file to point claude at the router",
      );
    }
    if (name === "--key") {
      return refused(
        "claudes: --key is not supported — the router key comes from the config written by `claudes login`",
      );
    }
    if (name === "--model") {
      const value = equals === -1 ? userArgs[++i] : arg.slice(equals + 1);
      // The value in the next position is argv too — scan it as well.
      if (looksLikeRouterKey(value)) {
        return refusedKey();
      }
      if (value === undefined) {
        argv.push("--model"); // dangling flag: claude reports it itself
      } else {
        argv.push("--model", mapModelValue(value));
      }
      continue;
    }
    argv.push(arg);
  }
  return { ok: true, argv: ["--settings", settingsPath, ...argv] };
}

function refused(message: string): ArgvResult {
  return { ok: false, exitCode: 64, message };
}

function refusedKey(): ArgvResult {
  return refused(
    "claudes: refusing an argument that looks like a router key — a key on the command line leaks into shell history and process listings",
  );
}
