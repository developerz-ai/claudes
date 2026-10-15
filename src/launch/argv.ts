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

/**
 * Builds the `claude` argv: the generated settings file first, then the user's
 * arguments. `--model claude-opus|claude-sonnet|claude-haiku` normalises to the
 * bare family name. A user `--settings` or `--key` is refused, as is any
 * argument containing a router key — and no refused value is ever echoed back.
 */
export function buildArgv(userArgs: readonly string[], settingsPath: string): ArgvResult {
  const argv: string[] = [];
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i] ?? "";
    // The scan runs on the whole token, whatever position a pasted key lands in.
    if (arg.includes(ROUTER_KEY_PREFIX)) {
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
      if (value?.includes(ROUTER_KEY_PREFIX) === true) {
        return refusedKey();
      }
      if (value === undefined) {
        argv.push("--model"); // dangling flag: claude reports it itself
      } else {
        argv.push("--model", MODEL_ALIASES[value] ?? value);
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
