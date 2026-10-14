import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, configFile } from "../config/paths";
import { readConfig } from "../config/store";
import type { FetchLike } from "../router/client";
import { type LoginDeps, login, redactKey } from "./login";

const ROUTER = "https://router.example.test";
const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-login-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface StubOptions {
  healthStatus?: number;
  healthBody?: string;
  modelsStatus?: number;
  modelsBody?: string;
  failWith?: Error;
}

function stubFetch(options: StubOptions = {}): { fetchImpl: FetchLike; calls: string[] } {
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

interface Harness {
  deps: LoginDeps;
  stdout: string[];
  stderr: string[];
  prompts: string[];
  writeConfigCalls: { path: string; config: unknown }[];
  fetchCalls: string[];
  failWrite?: Error;
}

function harness(overrides?: {
  fetch?: FetchLike;
  stdinIsTTY?: boolean;
  stdin?: string;
  stdinError?: Error;
  ttyKey?: string | undefined;
  env?: Record<string, string | undefined>;
  failWrite?: Error;
  /** Omit the injected store writer so the real store writes to the temp HOME. */
  realStore?: boolean;
}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];
  const writeConfigCalls: { path: string; config: unknown }[] = [];
  const fetchCalls: string[] = [];
  const inner = overrides?.fetch ?? stubFetch().fetchImpl;
  const deps: LoginDeps = {
    env: overrides?.env ?? { HOME: home },
    // Wrapped so tests can assert on whether the network was touched at all.
    fetch: async (url, init) => {
      fetchCalls.push(url);
      return inner(url, init);
    },
    stdinIsTTY: overrides?.stdinIsTTY ?? false,
    readSecret: async (prompt) => {
      prompts.push(prompt);
      // The real reader renders the prompt on stderr and echoes nothing else.
      stderr.push(prompt);
      return overrides?.ttyKey;
    },
    // Like the real reader: only the first line of stdin ever arrives.
    readStdinLine: async () => {
      if (overrides?.stdinError !== undefined) {
        throw overrides.stdinError;
      }
      if (overrides?.stdin === undefined) {
        return KEY;
      }
      const newline = overrides.stdin.indexOf("\n");
      return newline === -1 ? overrides.stdin : overrides.stdin.slice(0, newline);
    },
    stdout: (text) => {
      stdout.push(text);
    },
    ...(overrides?.failWrite !== undefined
      ? {
          writeConfig: () => {
            throw overrides.failWrite;
          },
        }
      : overrides?.realStore
        ? {}
        : {
            writeConfig: (path: string, config: unknown) => {
              writeConfigCalls.push({ path, config });
            },
          }),
  };
  return { deps, stdout, stderr, prompts, writeConfigCalls, fetchCalls };
}

function configPath(): string {
  return configFile(configDir({ HOME: home }));
}

/** The whole point: nothing the command produces may carry the full key. */
function expectNoKeyLeak(h: Harness, result: { ok: boolean; message?: string }): void {
  expect(result.message ?? "").not.toContain(KEY);
  expect(h.stdout.join("\n")).not.toContain(KEY);
  expect(h.stderr.join("\n")).not.toContain(KEY);
}

describe("login argument handling", () => {
  test("missing --url prints usage on stderr path and exits 64", async () => {
    const h = harness();
    const result = await login([], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toContain("usage: claudes login --url");
    expect(existsSync(configPath())).toBe(false);
  });

  test("refuses --key (and --key=…) with exit 64, without echoing the key", async () => {
    for (const argv of [
      ["--url", ROUTER, "--key", KEY],
      [`--url=${ROUTER}`, `--key=${KEY}`],
    ]) {
      const h = harness();
      const result = await login(argv, h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("Paste the key at the");
      expect(message).toContain("pipe it on stdin");
      expect(message).not.toContain(KEY);
    }
  });

  test("refuses a mar_live_ key in ANY argv position or --x=value form", async () => {
    for (const argv of [
      ["--url", KEY], // as the --url value
      ["--url", ROUTER, "--opus", KEY], // as a tier value
      [`--unknown=${KEY}`], // inline value of an unknown option
      [`--url=${ROUTER}`, `--haiku=${KEY}`],
      ["--url", ROUTER, KEY], // positional
    ]) {
      const h = harness();
      const result = await login(argv, h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("looks like a router key");
      expect(message).not.toContain(KEY);
      expect(h.prompts).toEqual([]);
    }
  });

  test("rejects an invalid --url before any I/O, without echoing the value", async () => {
    const h = harness();
    const result = await login(["--url", "https://x?not-a-key-but-secret"], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("invalid --url");
    expect(message).not.toContain("not-a-key-but-secret");
    expect(h.stdout.length + h.stderr.length).toBe(0);
    expect(h.prompts).toEqual([]);
  });

  test("unexpected and unknown arguments are named by position, never by value", async () => {
    const positional = harness();
    const positionalResult = await login(["--url", ROUTER, "s3cret-positional"], positional.deps);
    expect(positionalResult).toMatchObject({ ok: false, exitCode: 64 });
    expect(positionalResult.ok === false && positionalResult.message).toContain(
      "unexpected argument #3",
    );
    expect(positionalResult.ok === false && positionalResult.message).not.toContain(
      "s3cret-positional",
    );

    const unknown = harness();
    const unknownResult = await login(["--url", ROUTER, "--s3cret-flag", "v"], unknown.deps);
    expect(unknownResult).toMatchObject({ ok: false, exitCode: 64 });
    expect(unknownResult.ok === false && unknownResult.message).toContain("unknown option #3");
    expect(unknownResult.ok === false && unknownResult.message).not.toContain("s3cret-flag");
  });
});

describe("login environment", () => {
  test("resolves the config path first: no HOME means exit 78 before any prompt or fetch", async () => {
    const h = harness({ env: {} });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 78 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("cannot find the config directory");
    expect(message.split("\n").length).toBe(1); // one line, no stack trace
    expect(h.prompts).toEqual([]);
    expect(h.fetchCalls).toEqual([]);
    expect(existsSync(configPath())).toBe(false);
  });

  test("a stream error while reading the key exits 1 with a clean one-line message", async () => {
    const h = harness({ stdinError: new Error("EPIPE: broken pipe") });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("could not read the key from stdin");
    expect(message.split("\n").length).toBe(1); // one line, no stack trace
  });
});

describe("login key acquisition", () => {
  test("non-TTY: reads the first line of stdin and trims it", async () => {
    const h = harness({ stdin: `${KEY}\r\nsecond-line-ignored` });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.writeConfigCalls[0]?.config).toMatchObject({ key: KEY });
  });

  test("non-TTY: an empty stdin is a usage error", async () => {
    const h = harness({ stdin: "" });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toContain("no router key provided");
  });

  test("a key without the mar_live_ prefix is refused", async () => {
    const h = harness({ stdin: "sk-something-else" });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).not.toContain("sk-something-else");
  });

  const MALFORMED_KEYS: [string, string][] = [
    [`mar_live_${"A".repeat(31)}\0`, "an embedded NUL byte"],
    [`mar_live_${"A".repeat(31)}\r`, "a carriage return"],
    [`mar_live_${"A".repeat(31)}\t`, "a tab"],
    [`mar_live_${"A".repeat(16)} ${"A".repeat(15)}`, "an inner space"],
    [`mar_live_${"A".repeat(16)}é${"A".repeat(15)}`, "a non-ASCII character"],
    [`mar_live_${"A".repeat(31)}`, "one character too short"],
    [`mar_live_${"A".repeat(33)}`, "one character too long"],
  ];

  for (const [badKey, why] of MALFORMED_KEYS) {
    test(`never calls fetch for a malformed key (${why})`, async () => {
      const h = harness({ stdin: badKey });
      const result = await login(["--url", ROUTER], h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      expect(h.fetchCalls).toEqual([]);
      expect(existsSync(configPath())).toBe(false);
      // The refusal is a fixed sentence: no part of the input is echoed back
      // (the prefix in the message is itself scrubbed to the ellipsis form).
      expect(result.ok === false && result.message).toBe(
        "claudes login: that is not a valid router key (expected mar_live_… followed by 32 characters)",
      );
    });
  }

  test("TTY: prompts on stderr and never echoes the key", async () => {
    const h = harness({ stdinIsTTY: true, ttyKey: KEY });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.prompts).toEqual(["Router key: "]);
    expect(h.stderr.join("")).toContain("Router key: ");
    expect(h.stderr.join("")).not.toContain(KEY);
    expect(h.stdout.join("")).not.toContain(KEY);
  });

  test("TTY: Ctrl-C aborts with exit 130 and writes nothing", async () => {
    const h = harness({ stdinIsTTY: true, ttyKey: undefined });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 130 });
    expect(h.stdout).toEqual([]);
    expect(existsSync(configPath())).toBe(false);
  });
});

describe("login validation and output", () => {
  test("health failure names the endpoint and exits 1", async () => {
    const h = harness({
      fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }).fetchImpl,
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toContain("HTTP 503");
    expectNoKeyLeak(h, result);
  });

  test("models 401 maps to 'router rejected the key'", async () => {
    const h = harness({ fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }).fetchImpl });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("router rejected the key");
    expect(message).toContain("401");
    expectNoKeyLeak(h, result);
  });

  test("an invalid router version string is refused, not printed", async () => {
    const h = harness({
      fetch: stubFetch({ healthBody: JSON.stringify({ version: "1.4.2\nrm -rf /" }) }).fetchImpl,
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("invalid version string");
    expect(message).not.toContain("rm -rf");
  });

  test("tier overrides win over the advertised ids", async () => {
    const h = harness();
    const result = await login(["--url", ROUTER, "--opus", "claude-opus-9-9"], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.writeConfigCalls[0]?.config).toMatchObject({
      tiers: { opus: "claude-opus-9-9", sonnet: "claude-sonnet-4-5", haiku: "claude-haiku-4-5" },
    });
  });

  test("prints router version, redacted key, and the three tiers", async () => {
    const h = harness();
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    const out = h.stdout.join("\n");
    expect(out).toContain("router version 1.4.2");
    expect(out).toContain("mar_live_FAKE…");
    expect(out).toContain("opus   claude-opus-4-1");
    expect(out).toContain("sonnet claude-sonnet-4-5");
    expect(out).toContain("haiku  claude-haiku-4-5");
    expect(out).toContain(configPath());
  });

  test("stores the origin form of --url", async () => {
    const h = harness();
    const result = await login(["--url", "http://127.0.0.1:3000"], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.writeConfigCalls[0]?.config).toMatchObject({ baseUrl: "http://127.0.0.1:3000" });
  });
});

describe("login REDACTION end to end", () => {
  test("the full key never appears in stdout or stderr; only mar_live_FAKE…", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: LoginDeps = {
      // No injected writeConfig: the real store writes to the temp HOME.
      env: { HOME: home },
      fetch: stubFetch().fetchImpl,
      stdinIsTTY: false,
      readStdinLine: async () => KEY,
      readSecret: async () => {
        throw new Error("readSecret must not be called when stdin is not a TTY");
      },
      stdout: (text) => {
        stdout.push(text);
      },
    };
    const result = await login(["--url", ROUTER], deps);
    expect(result).toMatchObject({ ok: true });

    const out = stdout.join("\n");
    const err = stderr.join("\n");
    expect(out).toContain("mar_live_FAKE…");
    expect(out).not.toContain(KEY);
    expect(err).not.toContain(KEY);

    // The real config was written, secret and complete, with tight modes.
    const path = configPath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(configDir({ HOME: home })).mode & 0o777).toBe(0o700);
    const config = readConfig(path);
    expect(config.key).toBe(KEY);
    expect(config.baseUrl).toBe(ROUTER);
  });

  test("re-running replaces the config atomically, leaving no temp files", async () => {
    const first = harness({ realStore: true });
    await login(["--url", ROUTER], first.deps);
    const second = harness({
      stdin: "mar_live_SECONDKEYabcdef0123456789abcdefg",
      fetch: stubFetch().fetchImpl,
      realStore: true,
    });
    const result = await login(["--url", "https://other.example.test"], second.deps);
    expect(result).toMatchObject({ ok: true });
    const config = readConfig(configPath());
    expect(config.key).toBe("mar_live_SECONDKEYabcdef0123456789abcdefg");
    expect(config.baseUrl).toBe("https://other.example.test");
    expect(readdirSync(configDir({ HOME: home }))).toEqual(["config.json"]);
  });

  test("every failure branch leaves the key out of the message and all output", async () => {
    const branches: { name: string; h: Harness }[] = [
      {
        name: "401 from the router",
        h: harness({ fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }).fetchImpl }),
      },
      {
        name: "5xx from the router",
        h: harness({ fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }).fetchImpl }),
      },
      {
        name: "network error quoting the key",
        h: harness({
          fetch: stubFetch({
            failWith: new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
          }).fetchImpl,
        }),
      },
      { name: "write failure", h: harness({ failWrite: new Error("ENOSPC: no space left") }) },
      { name: "bad argv", h: harness() },
      { name: "malformed key", h: harness({ stdin: `mar_live_${"A".repeat(31)}\0` }) },
    ];
    for (const branch of branches) {
      const argv = branch.name === "bad argv" ? ["--url", KEY] : ["--url", ROUTER];
      const result = await login(argv, branch.h.deps);
      expect(result.ok).toBe(false);
      expect(result.ok === false ? (result.message ?? "") : "").not.toContain(KEY);
      expect(branch.h.stdout.join("\n")).not.toContain(KEY);
      expect(branch.h.stderr.join("\n")).not.toContain(KEY);
    }
  });

  test("a fetch error quoting the key produces key-free output", async () => {
    const h = harness({
      fetch: stubFetch({
        failWith: new Error(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
      }).fetchImpl,
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("could not reach");
    expect(message).toContain("(Error)");
    expectNoKeyLeak(h, result);
  });
});

describe("redactKey", () => {
  test("shows at most the prefix plus four characters", () => {
    expect(redactKey(KEY)).toBe("mar_live_FAKE…");
    expect(redactKey("mar_live_ABCDEFGH")).toBe("mar_live_ABCD…");
  });

  test("a key of 13 characters or fewer shows the prefix alone", () => {
    expect(redactKey("mar_live_ABCD")).toBe("mar_live_…");
    expect(redactKey("mar_live_")).toBe("mar_live_…");
    expect(redactKey("mar_live")).toBe("mar_live_…");
  });
});
