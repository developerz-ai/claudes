import { loadConfig } from "../config/load";
import type { Env } from "../config/paths";
import { firstReroutingUseToggle } from "../launch/provider-switches";

const TTY_REFUSAL = "claudes key is for apiKeyHelper only";
const USAGE = "usage: claudes key";

export interface KeyDeps {
  readonly env: Env;
  readonly stdoutIsTTY: boolean;
  /** The key's destination; only reached when stdout is not a TTY. */
  readonly write: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `claudes key`: prints the router key on stdout with no trailing newline.
 * Only apiKeyHelper is meant to call it — a terminal would just paste the key
 * into the scrollback, so a TTY stdout is refused with exit 64. The command
 * takes no arguments: any argument is refused with exit 64 before the TTY
 * check, the provider-switch check and the config read, so an unsupported
 * argument can never reach a credential write. The config is read through the
 * store, so insecure permissions are refused here exactly as they are at
 * launch time.
 */
export function runKey(argv: readonly string[], deps: KeyDeps): number {
  // First, before anything else: no argument is accepted, so the first one
  // after `key` is always the first unsupported one. The refusal names that
  // position and never the token — a pasted key must not be echoed back, so
  // the message carries no user input at all. The position is kept in the
  // message so that a future accepted flag does not change its shape.
  for (const [index] of argv.entries()) {
    deps.stderr(`claudes key: unknown argument #${index + 1}\n${USAGE}\n`);
    return 64;
  }
  if (deps.stdoutIsTTY) {
    deps.stderr(`${TTY_REFUSAL}\n`);
    return 64;
  }
  // Before any config is loaded or served: a CLAUDE_CODE_USE_ toggle pointing
  // the session at another provider means the session would not go to the
  // router, so the router key must not leave this process at all. The helper
  // subprocess inherits the merged settings env, so a switch planted in a
  // settings file is caught here too. Known switches and unknown future names
  // alike are refused; only the variable is named — never its value.
  const switched = firstReroutingUseToggle(deps.env);
  if (switched !== undefined) {
    deps.stderr(
      `claudes key: refusing: ${switched} is set, so this session would not go to the router\n`,
    );
    return 64;
  }
  const loaded = loadConfig(deps.env);
  if (!loaded.ok) {
    deps.stderr(`${loaded.message}\n`);
    return loaded.exitCode;
  }
  // After the config loads: the generated settings pin ANTHROPIC_BASE_URL to
  // the configured router, so an env value pointing anywhere else means this
  // key would be served into a session aimed at another endpoint. An unset (or
  // empty) value is the direct `claudes key | cat` case and is allowed. Only
  // the variable is named — never its value.
  const envBase = deps.env.ANTHROPIC_BASE_URL;
  if (envBase !== undefined && envBase !== "" && !sameOrigin(envBase, loaded.config.baseUrl)) {
    deps.stderr(
      "claudes key: refusing: ANTHROPIC_BASE_URL does not point at the configured router\n",
    );
    return 64;
  }
  deps.write(loaded.config.key);
  return 0;
}

/**
 * True when both URLs parse and share an origin (scheme, host, port) — the
 * trailing-slash variant of the same router matches. A URL that does not parse
 * is not the router's origin: fail closed.
 */
function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Injectables for the real process; what main.ts passes to runKey(). */
export function realKeyDeps(): KeyDeps {
  return {
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    write: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
