import { loadConfig } from "../config/load";
import type { Env } from "../config/paths";

const TTY_REFUSAL = "claudes key is for apiKeyHelper only";

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
 * into the scrollback, so a TTY stdout is refused with exit 64. The config is
 * read through the store, so insecure permissions are refused here exactly as
 * they are at launch time.
 */
export function runKey(deps: KeyDeps): number {
  if (deps.stdoutIsTTY) {
    deps.stderr(`${TTY_REFUSAL}\n`);
    return 64;
  }
  const loaded = loadConfig(deps.env);
  if (!loaded.ok) {
    deps.stderr(`${loaded.message}\n`);
    return loaded.exitCode;
  }
  deps.write(loaded.config.key);
  return 0;
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
