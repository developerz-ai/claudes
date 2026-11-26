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

export function hasRouterKey(args: readonly string[]): boolean {
  return args.some((token) => KEY_ON_ARGV.test(token));
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
 * Builds the `claude` argv with the generated settings first for a session
 * or immediately after the word for a dispatch command. `--model claude-opus|claude-sonnet|claude-haiku` (with an optional
 * `[1m]`) normalises to the bare family name. A user `--settings` or `--key` is
 * refused, as is any argument containing a router key — and no refused value is
 * ever echoed back. Everything after a `--` terminator is positional prompt
 * text, so the rewriting stops there — but the key-shape refusal does not: a
 * router-key-shaped token after `--` is still refused.
 */
export function buildArgv(
  userArgs: readonly string[],
  settingsPath: string,
  launchClass: "session" | "dispatch" = "session",
): ArgvResult {
  if (hasRouterKey(userArgs)) return refusedKey();
  const argv: string[] = [];
  const start = launchClass === "dispatch" ? 1 : 0;
  if (start === 1 && userArgs[0] !== undefined) argv.push(userArgs[0]);
  argv.push("--settings", settingsPath);
  for (let i = start; i < userArgs.length; i++) {
    const arg = userArgs[i] ?? "";
    if (arg === "--") {
      argv.push(...userArgs.slice(i));
      break;
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name === "--managed-settings" || name === "--managed-settings-in-initialize") {
      return refused(
        `claudes: ${name} is not supported — managed settings could override the router settings`,
      );
    }
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
      const next = userArgs[i + 1];
      let value: string | undefined;
      if (equals !== -1) {
        value = arg.slice(equals + 1);
      } else if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
      if (value === undefined) {
        argv.push("--model"); // missing value or another option: Claude Code handles it
      } else {
        argv.push("--model", mapModelValue(value));
      }
      continue;
    }
    argv.push(arg);
  }
  return { ok: true, argv };
}

function refused(message: string): Extract<ArgvResult, { ok: false }> {
  return { ok: false, exitCode: 64, message };
}

export function refusedKey(): Extract<ArgvResult, { ok: false }> {
  return refused(
    "claudes: refusing an argument that looks like a router key — a key on the command line leaks into shell history and process listings",
  );
}
