import { ROUTER_KEY_PREFIX } from "../config/schema";
import type { TierName } from "../tiers";

export const USAGE = `usage: claudes login --url <router-url> [--opus <model-id>] [--sonnet <model-id>] [--haiku <model-id>]

The router key is read from the "Router key: " prompt, or from the first line of
stdin when it is piped; it is never accepted as a command-line argument.`;

export interface ParsedArgs {
  url: string;
  overrides: Partial<Record<TierName, string>>;
}

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
    // The scan runs on the whole token so --url VALUE, --tier=VALUE and
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
      if (value === undefined || value === "") {
        return usageError(`claudes login: ${name} requires a value`);
      }
      // The value in the next position is argv too — scan it as well, so a key
      // slipped in as "--url VALUE" or "--opus VALUE" is refused the same way.
      if (value.includes(ROUTER_KEY_PREFIX)) {
        return refusedKey("claudes login: refusing an argument that looks like a router key");
      }
      if (name === "--url") {
        url = value;
      } else {
        overrides[name.slice(2) as TierName] = value;
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
