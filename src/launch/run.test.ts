import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configFile, settingsFile } from "../config/paths";
import { writeConfig } from "../config/store";
import type { FetchLike } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import {
  PREFLIGHT_TIMEOUT_NOTE_MESSAGE,
  PROXY_NOTE_MESSAGE,
  preflightTimeoutMs,
  ROUTER_UNREACHABLE_MESSAGE,
} from "./run";
import {
  cleanup,
  deadFetch,
  type Harness,
  harness,
  KEY,
  NODE,
  ROUTER,
  SCRIPT,
} from "./run-harness";

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(() => {
  cleanup(h);
});

function errText(): string {
  return h.err.join("");
}

describe("run: config gate", () => {
  test("no config at all: exit 78, the exact remedy, nothing spawned", async () => {
    rmSync(h.home, { recursive: true, force: true });
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
  });

  test("no usable HOME: same missing-config refusal", async () => {
    const code = await h.drive(["-p", "hi"], { env: { PATH: "/bin", HOME: undefined } });
    expect(code).toBe(78);
    expect(errText()).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
  });

  test("a base URL but no key (schema-invalid): exit 78, the store's message", async () => {
    rmSync(configFile(h.dir));
    writeFileSync(
      configFile(h.dir),
      JSON.stringify({ version: 1, baseUrl: ROUTER, tiers: {} }),
      "utf8",
    );
    chmodSync(configFile(h.dir), 0o600);
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toContain("not a valid claudes config");
    expect(h.spawnCalls).toEqual([]);
  });

  test("insecure config perms: exit 78, the store's refusal", async () => {
    chmodSync(configFile(h.dir), 0o644);
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toContain("readable by group or other users");
    expect(h.spawnCalls).toEqual([]);
  });
});

describe("run: argv gate", () => {
  for (const args of [
    ["--settings", "/tmp/mine.json"],
    ["--key", "x"],
    ["-p", KEY],
  ] as const) {
    test(`refuses ${JSON.stringify(args)} with exit 64, before any fetch or spawn`, async () => {
      const code = await h.drive(args, { fetch: deadFetch });
      expect(code).toBe(64);
      expect(h.spawnCalls).toEqual([]);
      expect(errText()).not.toContain(KEY);
      expect(errText()).not.toContain("/tmp/mine.json");
    });
  }
});

describe("run: router pre-flight", () => {
  test("an unreachable router: exit 69, the exact message, no spawn, no settings", async () => {
    const code = await h.drive(["-p", "hi"], { fetch: deadFetch });
    expect(code).toBe(69);
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
    expect(statSync(settingsFile(h.dir), { throwIfNoEntry: false })).toBeUndefined();
  });

  /** A fetch seam whose attempt throws exactly what a timed-out probe throws. */
  function timeoutFetch(behavior: (call: number) => "timeout" | "healthy"): FetchLike {
    let calls = 0;
    return async () => {
      calls += 1;
      if (behavior(calls) === "timeout") {
        const err = new Error("the probe timed out");
        err.name = "TimeoutError";
        throw err;
      }
      return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    };
  }

  test("a timed-out probe is retried once, and a healthy second attempt launches", async () => {
    const code = await h.drive(["-p", "hi"], {
      fetch: timeoutFetch((call) => (call === 1 ? "timeout" : "healthy")),
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    expect(h.spawnCalls.length).toBe(1);
  });

  test("a probe timing out twice: exit 69 after exactly two attempts, with the timeout note", async () => {
    let calls = 0;
    const alwaysTimeout: FetchLike = async () => {
      calls += 1;
      const err = new Error("the probe timed out");
      err.name = "TimeoutError";
      throw err;
    };
    expect(await h.drive(["-p", "hi"], { fetch: alwaysTimeout })).toBe(69);
    expect(calls).toBe(2);
    expect(h.spawnCalls).toEqual([]);
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n${PREFLIGHT_TIMEOUT_NOTE_MESSAGE}\n`);
  });

  test("a hard connection error is not retried: one attempt, exit 69", async () => {
    let calls = 0;
    const deadOnce: FetchLike = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    expect(await h.drive(["-p", "hi"], { fetch: deadOnce })).toBe(69);
    expect(calls).toBe(1);
  });

  for (const proxy of ["HTTPS_PROXY", "HTTP_PROXY"] as const) {
    test(`${proxy} set without NODE_USE_ENV_PROXY: the proxy note follows the message`, async () => {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, [proxy]: "http://proxy.corp.test:3128" },
        fetch: deadFetch,
      });
      expect(code).toBe(69);
      expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n${PROXY_NOTE_MESSAGE}\n`);
    });
  }

  test("NODE_USE_ENV_PROXY set: the note is suppressed", async () => {
    await h.drive(["-p", "hi"], {
      env: {
        HOME: h.home,
        PATH: h.binDir,
        HTTPS_PROXY: "http://proxy.corp.test:3128",
        NODE_USE_ENV_PROXY: "1",
      },
      fetch: deadFetch,
    });
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
  });

  test("an empty-string proxy is not a proxy: no note", async () => {
    await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, HTTPS_PROXY: "" },
      fetch: deadFetch,
    });
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
  });

  test("a reachable router prints nothing even when a proxy is set", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, HTTPS_PROXY: "http://proxy.corp.test:3128" },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    expect(errText()).toBe("");
  });
});

describe("preflightTimeoutMs", () => {
  test("defaults to 1500 and honours CLAUDES_PREFLIGHT_TIMEOUT_MS", () => {
    expect(preflightTimeoutMs({})).toBe(1500);
    expect(preflightTimeoutMs({ CLAUDES_PREFLIGHT_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(preflightTimeoutMs({ CLAUDES_PREFLIGHT_TIMEOUT_MS: "1" })).toBe(1);
    expect(preflightTimeoutMs({ CLAUDES_PREFLIGHT_TIMEOUT_MS: "2147483647" })).toBe(2_147_483_647);
  });

  test("ignores non-integer values in favor of the default", () => {
    for (const invalid of ["0.5", "2500.5", "1e10", "0", "-1", "abc"]) {
      expect(preflightTimeoutMs({ CLAUDES_PREFLIGHT_TIMEOUT_MS: invalid })).toBe(1500);
    }
  });

  test("ignores invalid values in favor of the default", () => {
    for (const invalid of ["", "  ", "1e999"]) {
      expect(preflightTimeoutMs({ CLAUDES_PREFLIGHT_TIMEOUT_MS: invalid })).toBe(1500);
    }
  });
});

describe("run: settings file", () => {
  test("written 0600 inside the 0700 config dir, with the generated payload", async () => {
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    const path = settingsFile(h.dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(h.dir).mode & 0o777).toBe(0o700);
    const text = await Bun.file(path).text();
    const payload = JSON.parse(text);
    expect(payload.apiKeyHelper).toBe(`'${NODE}' '${SCRIPT}' key`);
    expect(payload.permissions).toEqual({ deny: ["WebSearch"] });
    expect(payload.env.ANTHROPIC_BASE_URL).toBe(ROUTER);
    expect(payload.env.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(payload.env.CLAUDE_CODE_USE_BEDROCK).toBe("");
    assertNoKeyFragment(text, KEY);
  });

  test("a symlinked config dir: the ConfigError's own message, exit 1, no spawn", async () => {
    // The config stays readable through the symlink; only the settings write
    // refuses it, because chmod through a symlink would tighten someone else's
    // directory.
    const real = `${h.home}/real-config-dir`;
    mkdirSync(real, { recursive: true });
    writeConfig(configFile(real), {
      version: 1,
      baseUrl: ROUTER,
      key: KEY,
      tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    });
    rmSync(h.dir, { recursive: true, force: true });
    symlinkSync(real, h.dir);
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(1);
    expect(errText()).toBe(
      `refusing to write settings: ${h.dir} is a symbolic link — remove it and re-run "claudes login"\n`,
    );
    expect(h.spawnCalls).toEqual([]);
  });

  test("a non-Config write failure names the errno code", async () => {
    // A directory at the settings path makes the final rename fail with an
    // errno (EISDIR/ENOTDIR), which is all the message may carry.
    mkdirSync(settingsFile(h.dir));
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/^claudes: could not write the settings file at .+ \(E[A-Z]+\)\n$/);
    expect(h.spawnCalls).toEqual([]);
  });
});

describe("run: redaction", () => {
  test("no error path ever leaks the key", async () => {
    await h.drive(["-p", "hi"], { fetch: deadFetch });
    await h.drive(["-p", KEY]);
    await h.drive(["-p", "hi"], { env: { HOME: h.home, PATH: "/nonexistent" } });
    assertNoKeyFragment(errText(), KEY);
  });
});
