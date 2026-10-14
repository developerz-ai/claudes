import { configDir, configFile } from "../config/paths";
import type { FetchLike } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import type { LoginDeps } from "./login";

/** Shared fixtures for the login test files; deliberately framework-free. */
export const ROUTER = "https://router.example.test";
export const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

export interface StubOptions {
  healthStatus?: number;
  healthBody?: string;
  modelsStatus?: number;
  modelsBody?: string;
  failWith?: Error;
}

export function stubFetch(options: StubOptions = {}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (options.failWith !== undefined) {
      throw options.failWith;
    }
    if (url.endsWith("/healthz")) {
      return new Response(options.healthBody ?? JSON.stringify({ version: "1.4.2" }), {
        status: options.healthStatus ?? 200,
      });
    }
    return new Response(
      options.modelsBody ??
        JSON.stringify({
          data: [
            { id: "claude-opus-4-1" },
            { id: "claude-sonnet-4-5" },
            { id: "claude-haiku-4-5" },
          ],
        }),
      { status: options.modelsStatus ?? 200 },
    );
  };
  return { fetchImpl, calls };
}

export interface Harness {
  deps: LoginDeps;
  stdout: string[];
  prompts: string[];
  writeConfigCalls: { path: string; config: unknown }[];
  fetchCalls: string[];
}

export interface HarnessOptions {
  fetch?: FetchLike;
  stdinIsTTY?: boolean;
  stdin?: string;
  stdinError?: Error;
  ttyKey?: string | undefined;
  ttyError?: Error;
  env?: Record<string, string | undefined>;
  failWrite?: Error;
  /** Omit the injected store writer so the real store writes to the temp HOME. */
  realStore?: boolean;
}

export function harness(home: string, overrides: HarnessOptions = {}): Harness {
  const stdout: string[] = [];
  const prompts: string[] = [];
  const writeConfigCalls: { path: string; config: unknown }[] = [];
  const fetchCalls: string[] = [];
  const inner = overrides.fetch ?? stubFetch().fetchImpl;
  const deps: LoginDeps = {
    env: overrides.env ?? { HOME: home },
    // Wrapped so tests can assert on whether the network was touched at all.
    fetch: async (url, init) => {
      fetchCalls.push(url);
      return inner(url, init);
    },
    stdinIsTTY: overrides.stdinIsTTY ?? false,
    readSecret:
      overrides.ttyError === undefined
        ? async (prompt) => {
            prompts.push(prompt);
            return overrides.ttyKey;
          }
        : async () => {
            throw overrides.ttyError;
          },
    // Like the real reader: only the first line of stdin ever arrives.
    readStdinLine: async () => {
      if (overrides.stdinError !== undefined) {
        throw overrides.stdinError;
      }
      if (overrides.stdin === undefined) {
        return KEY;
      }
      const newline = overrides.stdin.indexOf("\n");
      return newline === -1 ? overrides.stdin : overrides.stdin.slice(0, newline);
    },
    stdout: (text) => {
      stdout.push(text);
    },
    ...(overrides.failWrite !== undefined
      ? {
          writeConfig: () => {
            throw overrides.failWrite;
          },
        }
      : overrides.realStore
        ? {}
        : {
            writeConfig: (path: string, config: unknown) => {
              writeConfigCalls.push({ path, config });
            },
          }),
  };
  return { deps, stdout, prompts, writeConfigCalls, fetchCalls };
}

export function configPath(home: string): string {
  return configFile(configDir({ HOME: home }));
}

/** The whole point: no part of the key body may survive into any output. */
export function expectNoKeyLeak(h: Harness, result: { ok: boolean; message?: string }): void {
  const message = result.message ?? "";
  const out = h.stdout.join("\n");
  if (message.includes(KEY) || out.includes(KEY)) {
    throw new Error("the full key leaked into the output");
  }
  assertNoKeyFragment(`${message}\n${out}`, KEY);
}
