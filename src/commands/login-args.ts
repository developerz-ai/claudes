import { ROUTER_KEY_PREFIX } from "../config/schema";
import { parseTierId, type TierName } from "../tiers";

const USAGE = `usage: claudes login --url <router-url> [--opus <model-id>] [--sonnet <model-id>] [--haiku <model-id>]

The router key is read from the "Router key: " prompt, or from the first line of
stdin when it is piped; it is never accepted as a command-line argument.`;

export interface ParsedArgs {
  url: string;
  overrides: Partial<Record<TierName, string>>;
}

/**
 * Bound input to printable, shell-safe characters before applying the shared
 * Claude tier-id contract: undecorated ids only, not aliases or variants.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:[\]-]{1,100}$/;

export type ArgsResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly exitCode: number; readonly message: string };

/**
 * Parses `claudes login` argv. No argv value is ever echoed back — a pasted key
 * in any position (`--url VALUE`, `--x=VALUE`, a positional) is refused by the
 * prefix scan before anything else, and other rejections name the position, not
 * the value.
 */
export function parseLoginArgs(argv: readonly string[]): ArgsResult {
  const overrides: Partial<Record<TierName, string>> = {};
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    // The scan runs on the whole token so --url VALUE, --opus=VALUE and
    // positionals are all covered, whatever position the key lands in.
    if (arg.includes(ROUTER_KEY_PREFIX)) {
      return refusedKey("claudes login: refusing an argument that looks like a router key");
    }
    if (arg === "--key" || arg.startsWith("--key=")) {
      return refusedKey("claudes login: --key is not supported");
    }
    const equals = arg.indexOf("=");
    const name = arg.startsWith("--") && equals !== -1 ? arg.slice(0, equals) : arg;
    const inlineValue = name === arg ? undefined : arg.slice(equals + 1);
    if (name === "--url" || name === "--opus" || name === "--sonnet" || name === "--haiku") {
      const value = inlineValue ?? argv[++i];
      // The value in the next position is argv too — scan it as well, so a key
      // slipped in as "--url VALUE" or "--opus VALUE" is refused the same way.
      // This runs before the value checks below so a pasted key always gets the
      // key-refusal message, never a usage error that names only the flag.
      if (value?.includes(ROUTER_KEY_PREFIX)) {
        return refusedKey("claudes login: refusing an argument that looks like a router key");
      }
      // A value that starts with "-" is the next flag, not a value: neither a
      // bounded model id nor an https:// URL can legitimately begin with "-",
      // so the flag was given without its value (next-token and inline forms).
      if (value === undefined || value === "" || value.startsWith("-")) {
        return usageError(`claudes login: ${name} requires a value`);
      }
      if (name === "--url") {
        // Rejected by flag name, never by value: the second URL is as
        // unprintable as the first.
        if (url !== undefined) {
          return usageError("claudes login: --url may only be given once");
        }
        url = value;
      } else if (MODEL_ID_PATTERN.test(value) && parseTierId(value) !== undefined) {
        overrides[name.slice(2) as TierName] = value;
      } else {
        // Names the flag, never the value: a model id slot is exactly where a
        // pasted key or other junk would otherwise be echoed back.
        return usageError(
          `claudes login: ${name} is not a valid model id — use an undecorated Claude tier ID`,
        );
      }
      continue;
    }
    if (arg.startsWith("--")) {
      return usageError(`claudes login: unknown option #${i + 1}`);
    }
    return usageError(`claudes login: unexpected argument #${i + 1}`);
  }
  if (url === undefined) {
    return usageError();
  }
  return { ok: true, args: { url, overrides } };
}

function usageError(message?: string): { ok: false; exitCode: number; message: string } {
  return {
    ok: false,
    exitCode: 64,
    message: message === undefined ? USAGE : `${message}\n\n${USAGE}`,
  };
}

function refusedKey(lede: string): { ok: false; exitCode: number; message: string } {
  return {
    ok: false,
    exitCode: 64,
    message: `${lede} — a key on the command line leaks into shell history and process listings. Paste the key at the "Router key: " prompt instead, or pipe it on stdin:
  printf '%s\\n' "$CLAUDES_KEY" | claudes login --url <router-url>`,
  };
}
