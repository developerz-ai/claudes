import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, configFile } from "../config/paths";
import { readConfig } from "../config/store";
import type { FetchLike } from "../router/client";
import {
  type LoginDeps,
  login,
  type ReadableLike,
  readFirstLine,
  readSecret,
  type TtyStdin,
} from "./login";

const ROUTER = "https://router.example.test";
const KEY = "mar_live_FAKEKEYabcdef0123456789";

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

function stubFetch(options: StubOptions = {}): FetchLike {
  return async (url) => {
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
}

interface Harness {
  deps: LoginDeps;
  stdout: string[];
  stderr: string[];
  prompts: string[];
  writeConfigCalls: { path: string; config: unknown }[];
}

function harness(overrides?: {
  fetch?: FetchLike;
  stdinIsTTY?: boolean;
  stdin?: string;
  ttyKey?: string | undefined;
  /** Omit the injected store writer so the real store writes to the temp HOME. */
  realStore?: boolean;
}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];
  const writeConfigCalls: { path: string; config: unknown }[] = [];
  const deps: LoginDeps = {
    env: { HOME: home },
    fetch: overrides?.fetch ?? stubFetch(),
    stdinIsTTY: overrides?.stdinIsTTY ?? false,
    readSecret: async (prompt) => {
      prompts.push(prompt);
      // The real reader renders the prompt on stderr and echoes nothing else.
      stderr.push(prompt);
      return overrides?.ttyKey;
    },
    // Like the real reader: only the first line of stdin ever arrives.
    readStdinLine: async () => {
      if (overrides?.stdin === undefined) {
        return KEY;
      }
      const newline = overrides.stdin.indexOf("\n");
      return newline === -1 ? overrides.stdin : overrides.stdin.slice(0, newline);
    },
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    ...(overrides?.realStore
      ? {}
      : {
          writeConfig: (path: string, config: unknown) => {
            writeConfigCalls.push({ path, config });
          },
        }),
  };
  return { deps, stdout, stderr, prompts, writeConfigCalls };
}

function configPath(): string {
  return configFile(configDir({ HOME: home }));
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

  test("refuses a positional argument that looks like a key", async () => {
    const h = harness();
    const result = await login(["--url", ROUTER, KEY], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("looks like a router key");
    expect(message).not.toContain(KEY);
  });

  test("rejects an invalid --url before any I/O", async () => {
    const h = harness();
    const result = await login(["--url", "http://router.example.test/subpath/"], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toContain("invalid --url");
    expect(h.stdout.length + h.stderr.length).toBe(0);
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
    expect(result.ok === false && result.message).toContain('must start with "mar_live_"');
  });

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
    const h = harness({ fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }) });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toContain("HTTP 503");
  });

  test("models 401 maps to 'router rejected the key'", async () => {
    const h = harness({ fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }) });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("router rejected the key");
    expect(message).toContain("401");
    expect(message).not.toContain(KEY);
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
});

describe("login REDACTION end to end", () => {
  test("the full key never appears in stdout or stderr; only mar_live_FAKE…", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: LoginDeps = {
      // No injected writeConfig: the real store writes to the temp HOME.
      env: { HOME: home },
      fetch: stubFetch(),
      stdinIsTTY: false,
      readStdinLine: async () => KEY,
      readSecret: async () => {
        throw new Error("readSecret must not be called when stdin is not a TTY");
      },
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (text) => {
        stderr.push(text);
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
      stdin: "mar_live_SECONDKEYabcdef01",
      fetch: stubFetch(),
      realStore: true,
    });
    const result = await login(["--url", "https://other.example.test"], second.deps);
    expect(result).toMatchObject({ ok: true });
    const config = readConfig(configPath());
    expect(config.key).toBe("mar_live_SECONDKEYabcdef01");
    expect(config.baseUrl).toBe("https://other.example.test");
    expect(readdirSync(configDir({ HOME: home }))).toEqual(["config.json"]);
  });
});

class FakeTty extends EventEmitter {
  readonly rawModes: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
}

function asTty(tty: FakeTty): TtyStdin {
  return tty;
}

describe("readSecret (real hidden reader)", () => {
  test("writes only the prompt and a newline — never the typed characters", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "Router key: ");
    tty.emit("data", Buffer.from("mar_live_"));
    tty.emit("data", Buffer.from("SECRET"));
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("mar_live_SECRET");
    expect(writes).toEqual(["Router key: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("Ctrl-C resolves undefined and restores the terminal", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "Router key: ");
    tty.emit("data", Buffer.concat([Buffer.from("abc"), Buffer.from([0x03])]));
    await expect(secret).resolves.toBeUndefined();
    expect(writes).toEqual(["Router key: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });
});

class FakeReadable extends EventEmitter {}

function asReadable(stream: FakeReadable): ReadableLike {
  return stream;
}

describe("readFirstLine (real stdin reader)", () => {
  test("stops at the first newline, even mid-chunk", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from(`${KEY}\nrest is ignored`));
    await expect(line).resolves.toBe(KEY);
  });

  test("resolves the whole buffer at EOF when there is no newline", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", "mar_live_NOEOF");
    stream.emit("end");
    await expect(line).resolves.toBe("mar_live_NOEOF");
  });
});
