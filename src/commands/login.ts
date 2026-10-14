import { configDir, configFile, type Env } from "../config/paths";
import {
  baseUrlSchema,
  type Config,
  formatZodIssues,
  ROUTER_KEY_PATTERN,
  ROUTER_KEY_PREFIX,
} from "../config/schema";
import { writeConfig } from "../config/store";
import { type FetchLike, health, models, RouterError, scrub } from "../router/client";
import { resolveTiers } from "../tiers";
import { parseLoginArgs } from "./login-args";
import { readFirstLine, readSecret } from "./login-input";

/**
 * `mar_live_` plus at most the first four characters after the prefix. Never
 * more; a key too short to even carry that much shows the prefix alone.
 */
export function redactKey(key: string): string {
  const keep = key.slice(0, ROUTER_KEY_PREFIX.length + 4);
  return key.length <= ROUTER_KEY_PREFIX.length + 4 ? `${ROUTER_KEY_PREFIX}…` : `${keep}…`;
}

export interface LoginDeps {
  readonly env: Env;
  readonly fetch: FetchLike;
  readonly stdinIsTTY: boolean;
  /** Prompt with echo off; resolves undefined when the user hits Ctrl-C. */
  readonly readSecret: (prompt: string) => Promise<string | undefined>;
  /** Non-TTY path: the first line of stdin. */
  readonly readStdinLine: () => Promise<string>;
  readonly stdout: (text: string) => void;
  /** Defaults to the real store writer; injected in unit tests. */
  readonly writeConfig?: typeof writeConfig;
}

export type LoginResult =
  | { readonly ok: true; readonly configPath: string; readonly config: Config }
  | { readonly ok: false; readonly exitCode: number; readonly message?: string };

/** Every failure message passes through scrub: no key can survive the output path. */
function failure(exitCode: number, message?: string): LoginResult {
  return { ok: false, exitCode, message: message === undefined ? undefined : scrub(message) };
}

/** Orchestrates `claudes login`. Never touches the process directly: all I/O is injected. */
export async function login(argv: readonly string[], deps: LoginDeps): Promise<LoginResult> {
  const parsed = parseLoginArgs(argv);
  if (!parsed.ok) {
    return { ok: false, exitCode: parsed.exitCode, message: parsed.message };
  }

  // Resolve where the config will land before reading the key or touching the
  // network: a broken environment must fail fast, not after the user typed a
  // secret into a prompt that was about to be wasted.
  let path: string;
  try {
    path = configFile(configDir(deps.env));
  } catch {
    return failure(
      78,
      "claudes login: cannot find the config directory — set $HOME or $XDG_CONFIG_HOME",
    );
  }

  const url = resolveBaseUrl(parsed.args.url);
  if (typeof url !== "string") {
    return failure(64, `claudes login: invalid --url (${url.reason})`);
  }

  let raw: string | undefined;
  try {
    raw = deps.stdinIsTTY ? await deps.readSecret("Router key: ") : await deps.readStdinLine();
  } catch (err) {
    return failure(1, `claudes login: could not read the key from stdin: ${errorMessage(err)}`);
  }
  if (raw === undefined) {
    // Ctrl-C at the prompt.
    return failure(130);
  }
  const key = raw.trim();
  if (key === "") {
    return failure(
      64,
      "claudes login: no router key provided — paste it at the prompt or pipe it on stdin",
    );
  }
  // Validated against the exact router shape before any network call: Node's
  // fetch rejects malformed header values by quoting them in the error.
  if (!ROUTER_KEY_PATTERN.test(key)) {
    return failure(
      64,
      "claudes login: that is not a valid router key (expected mar_live_ followed by 32 characters)",
    );
  }

  let routerVersion: string;
  try {
    routerVersion = await health(url, deps.fetch);
  } catch (err) {
    return failure(1, `claudes login: health check failed: ${describeRouterError(err, url)}`);
  }

  let modelIds: string[];
  try {
    modelIds = await models(url, key, deps.fetch);
  } catch (err) {
    if (err instanceof RouterError && (err.status === 401 || err.status === 403)) {
      return failure(1, `claudes login: router rejected the key (HTTP ${err.status})`);
    }
    return failure(1, `claudes login: could not list models: ${describeRouterError(err, url)}`);
  }

  const tiers = resolveTiers(modelIds, parsed.args.overrides);
  const config: Config = { version: 1, baseUrl: url, key, tiers };

  try {
    (deps.writeConfig ?? writeConfig)(path, config);
  } catch (err) {
    return failure(1, `claudes login: could not save the config to ${path}: ${errorMessage(err)}`);
  }

  deps.stdout(`logged in to ${url} (router version ${routerVersion})`);
  deps.stdout(`key ${redactKey(key)}`);
  deps.stdout(`opus   ${tiers.opus}`);
  deps.stdout(`sonnet ${tiers.sonnet}`);
  deps.stdout(`haiku  ${tiers.haiku}`);
  deps.stdout(`config saved to ${path}`);
  return { ok: true, configPath: path, config };
}

/** The schema check plus the origin it implies; the stored URL is always the origin. */
function resolveBaseUrl(value: string): string | { reason: string } {
  const check = baseUrlSchema.safeParse(value);
  if (!check.success) {
    return { reason: formatZodIssues(check.error) };
  }
  return new URL(value).origin;
}

function describeRouterError(err: unknown, url: string): string {
  return err instanceof RouterError ? err.message : `could not reach ${url} (${errorName(err)})`;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Real-process wiring for `claudes login`; returns the process exit code. */
export async function runLogin(argv: readonly string[]): Promise<number> {
  const writeErr = (text: string) => {
    process.stderr.write(scrub(text));
  };
  const deps: LoginDeps = {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    stdinIsTTY: process.stdin.isTTY === true,
    readSecret: (prompt) => readSecret(process.stdin, writeErr, prompt),
    readStdinLine: () => readFirstLine(process.stdin),
    stdout: (text) => console.log(scrub(text)),
  };
  const result = await login(argv, deps);
  if (result.ok) {
    return 0;
  }
  if (result.message !== undefined) {
    console.error(scrub(result.message));
  }
  return result.exitCode;
}
