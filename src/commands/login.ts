import { Buffer } from "node:buffer";
import { configDir, configFile, type Env } from "../config/paths";
import { baseUrlSchema, type Config, formatZodIssues } from "../config/schema";
import { writeConfig } from "../config/store";
import { type FetchLike, health, models, RouterError } from "../router/client";
import { resolveTiers, type TierName } from "../tiers";

const USAGE = `usage: claudes login --url <router-url> [--opus <model-id>] [--sonnet <model-id>] [--haiku <model-id>]

The router key is read from the "Router key: " prompt, or from the first line of
stdin when it is piped; it is never accepted as a command-line argument.`;

const KEY_PREFIX = "mar_live_";

/** `mar_live_` plus at most the first four characters after the prefix. Never more. */
export function redactKey(key: string): string {
  return `${key.slice(0, KEY_PREFIX.length + 4)}…`;
}

/**
 * Minimal event-emitting stream surface login reads from. Real stdin and the
 * test fakes (plain EventEmitters) both satisfy it.
 */
export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): void;
  removeListener(event: "end", listener: () => void): void;
  removeListener(event: "error", listener: (err: Error) => void): void;
}

/** A readable stream that can be switched into (and out of) raw mode. */
export interface TtyStdin extends ReadableLike {
  setRawMode(mode: boolean): void;
}

/**
 * Reads one line with echo off: the prompt goes to `write`, typed characters go
 * nowhere. Enter submits; Ctrl-C resolves undefined, which the caller maps to
 * exit code 130.
 */
export function readSecret(
  input: TtyStdin,
  write: (text: string) => void,
  prompt: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let line = "";
    const stop = () => {
      input.removeListener("data", onData);
      input.setRawMode(false);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const byte of bytes) {
        if (byte === 0x03) {
          // Ctrl-C
          stop();
          write("\n");
          resolve(undefined);
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          // Enter
          stop();
          write("\n");
          resolve(line);
          return;
        }
        if (byte === 0x08 || byte === 0x7f) {
          line = line.slice(0, -1); // Backspace, Delete
        } else {
          line += String.fromCharCode(byte);
        }
      }
    };
    write(prompt);
    input.setRawMode(true);
    input.on("data", onData);
  });
}

/** Reads everything up to the first newline (or to EOF when there is none). */
export function readFirstLine(input: ReadableLike): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(buffer.slice(0, newline));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

export interface LoginDeps {
  readonly env: Env;
  readonly fetch: FetchLike;
  readonly stdinIsTTY: boolean;
  /** Prompt on stderr with echo off; resolves undefined when the user hits Ctrl-C. */
  readonly readSecret: (prompt: string) => Promise<string | undefined>;
  /** Non-TTY path: the first line of stdin. */
  readonly readStdinLine: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Defaults to the real store writer; injected in unit tests. */
  readonly writeConfig?: typeof writeConfig;
}

export type LoginResult =
  | { readonly ok: true; readonly configPath: string; readonly config: Config }
  | { readonly ok: false; readonly exitCode: number; readonly message?: string };

type ParsedArgs = { url: string; overrides: Partial<Record<TierName, string>> };

function parseLoginArgs(
  argv: readonly string[],
): { ok: true; args: ParsedArgs } | { ok: false; exitCode: number; message: string } {
  const overrides: Partial<Record<TierName, string>> = {};
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
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
      if (name === "--url") {
        url = value;
      } else {
        overrides[name.slice(2) as TierName] = value;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      return usageError(`claudes login: unknown option ${name}`);
    }
    if (arg.startsWith(KEY_PREFIX)) {
      return refusedKey("claudes login: refusing an argument that looks like a router key");
    }
    return usageError(`claudes login: unexpected argument ${arg}`);
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

/** Orchestrates `claudes login`. Never touches the process directly: all I/O is injected. */
export async function login(argv: readonly string[], deps: LoginDeps): Promise<LoginResult> {
  const parsed = parseLoginArgs(argv);
  if (!parsed.ok) {
    return { ok: false, exitCode: parsed.exitCode, message: parsed.message };
  }

  const urlCheck = baseUrlSchema.safeParse(parsed.args.url);
  if (!urlCheck.success) {
    return {
      ok: false,
      exitCode: 64,
      message: `claudes login: invalid --url ${parsed.args.url}: ${formatZodIssues(urlCheck.error)}`,
    };
  }
  const url = parsed.args.url;

  const raw = deps.stdinIsTTY ? await deps.readSecret("Router key: ") : await deps.readStdinLine();
  if (raw === undefined) {
    // Ctrl-C at the prompt.
    return { ok: false, exitCode: 130 };
  }
  const key = raw.trim();
  if (key === "") {
    return {
      ok: false,
      exitCode: 64,
      message: "claudes login: no router key provided — paste it at the prompt or pipe it on stdin",
    };
  }
  if (!key.startsWith(KEY_PREFIX)) {
    return {
      ok: false,
      exitCode: 64,
      message: `claudes login: router key must start with "${KEY_PREFIX}"`,
    };
  }

  let routerVersion: string;
  try {
    routerVersion = await health(url, deps.fetch);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      message: `claudes login: health check failed: ${describeRouterError(err, url)}`,
    };
  }

  let modelIds: string[];
  try {
    modelIds = await models(url, key, deps.fetch);
  } catch (err) {
    if (err instanceof RouterError && (err.status === 401 || err.status === 403)) {
      return {
        ok: false,
        exitCode: 1,
        message: `claudes login: router rejected the key (HTTP ${err.status})`,
      };
    }
    return {
      ok: false,
      exitCode: 1,
      message: `claudes login: could not list models: ${describeRouterError(err, url)}`,
    };
  }

  const tiers = resolveTiers(modelIds, parsed.args.overrides);
  const config: Config = { version: 1, baseUrl: url, key, tiers };

  const path = configFile(configDir(deps.env));
  try {
    (deps.writeConfig ?? writeConfig)(path, config);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      message: `claudes login: could not save the config to ${path}: ${errorMessage(err)}`,
    };
  }

  deps.stdout(`logged in to ${url} (router version ${routerVersion})`);
  deps.stdout(`key ${redactKey(key)}`);
  deps.stdout(`opus   ${tiers.opus}`);
  deps.stdout(`sonnet ${tiers.sonnet}`);
  deps.stdout(`haiku  ${tiers.haiku}`);
  deps.stdout(`config saved to ${path}`);
  return { ok: true, configPath: path, config };
}

/** Real-process wiring for `claudes login`; returns the process exit code. */
export async function runLogin(argv: readonly string[]): Promise<number> {
  const writeErr = (text: string) => {
    process.stderr.write(text);
  };
  const deps: LoginDeps = {
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    stdinIsTTY: process.stdin.isTTY === true,
    readSecret: (prompt) => readSecret(process.stdin, writeErr, prompt),
    readStdinLine: () => readFirstLine(process.stdin),
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  };
  const result = await login(argv, deps);
  if (result.ok) {
    return 0;
  }
  if (result.message !== undefined) {
    console.error(result.message);
  }
  return result.exitCode;
}

function describeRouterError(err: unknown, url: string): string {
  return err instanceof RouterError ? err.message : `could not reach ${url}: ${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
