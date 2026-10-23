import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir } from "../config/paths";
import { readConfig } from "../config/store";
import { scrub } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import { type LoginDeps, login, REDACTED_KEY } from "./login";
import {
  configPath,
  expectNoKeyLeak,
  type Harness,
  harness,
  KEY,
  ROUTER,
  stubFetch,
} from "./login-harness";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-login-out-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A proxy whose getPrototypeOf trap throws: every bare `instanceof` on it throws. */
function prototypeTrap(): Error {
  return new Proxy(new TypeError("fetch failed"), {
    getPrototypeOf() {
      throw new Error(`trap exploded ${KEY}`);
    },
  });
}

/**
 * A Response whose `status` getter throws the trap: the throw happens in
 * health()/models() outside their wrapping try, so the raw trap is what
 * login's catch blocks see.
 */
function trappingStatusResponse(): Response {
  return {
    headers: new Headers(),
    body: null,
    get status(): number {
      throw prototypeTrap();
    },
  } as unknown as Response;
}

describe("login validation and output", () => {
  test("health failure names the endpoint and exits 1", async () => {
    const h = harness(home, {
      fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }),
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toContain("HTTP 503");
    expectNoKeyLeak(h, result);
  });

  test("models 401 maps to 'router rejected the key'", async () => {
    const h = harness(home, {
      fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }),
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("router rejected the key");
    expect(message).toContain("401");
    expectNoKeyLeak(h, result);
  });

  test("a prototype-trapped health failure is described by shape, never thrown", async () => {
    // A bare instanceof in describeRouterError would let the trap escape
    // login() itself, breaking the always-returns-a-LoginResult contract.
    const h = harness(home, { fetch: async () => trappingStatusResponse() });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toBe(
      `claudes login: health check failed: could not reach ${ROUTER} (Error)`,
    );
    expectNoKeyLeak(h, result);
  });

  test("a prototype-trapped models failure is described by shape, never thrown", async () => {
    // Same trap on the models response: the 401/403 check must read false,
    // not throw, and the failure falls through to the shaped description.
    const h = harness(home, {
      fetch: async (url) =>
        url.endsWith("/healthz")
          ? new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 })
          : trappingStatusResponse(),
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toBe(
      `claudes login: could not list models: could not reach ${ROUTER} (Error)`,
    );
    expectNoKeyLeak(h, result);
  });

  test("an invalid router version string is refused, not printed", async () => {
    const h = harness(home, {
      fetch: stubFetch({ healthBody: JSON.stringify({ version: "1.4.2\nrm -rf /" }) }),
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("invalid version string");
    expect(message).not.toContain("rm -rf");
  });

  test("tier overrides win over the advertised ids", async () => {
    const h = harness(home);
    const result = await login(["--url", ROUTER, "--opus", "claude-opus-9-9"], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.writeConfigCalls[0]?.config).toMatchObject({
      tiers: { opus: "claude-opus-9-9", sonnet: "claude-sonnet-4-5", haiku: "claude-haiku-4-5" },
    });
  });

  test("prints router version, redacted key, and the three tiers", async () => {
    const h = harness(home);
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: true });
    const out = h.stdout.join("\n");
    expect(out).toContain("router version 1.4.2");
    expect(out).toContain("key mar_live_…");
    expect(out).toContain("opus   claude-opus-4-1");
    expect(out).toContain("sonnet claude-sonnet-4-5");
    expect(out).toContain("haiku  claude-haiku-4-5");
    expect(out).toContain(configPath(home));
    assertNoKeyFragment(out, KEY);
  });

  test("stores the origin form of --url", async () => {
    const h = harness(home);
    const result = await login(["--url", "http://127.0.0.1:3000"], h.deps);
    expect(result).toMatchObject({ ok: true });
    expect(h.writeConfigCalls[0]?.config).toMatchObject({ baseUrl: "http://127.0.0.1:3000" });
  });
});

describe("login REDACTION end to end", () => {
  test("no fragment of the key ever appears in stdout; the redaction is exactly mar_live_…", async () => {
    const stdout: string[] = [];
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
    };
    const result = await login(["--url", ROUTER], deps);
    expect(result).toMatchObject({ ok: true });

    const out = stdout.join("\n");
    expect(out).toContain("key mar_live_…");
    expect(out).not.toContain(KEY);
    assertNoKeyFragment(out, KEY);

    // The real config was written, secret and complete, with tight modes.
    const path = configPath(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(configDir({ HOME: home })).mode & 0o777).toBe(0o700);
    const config = readConfig(path);
    expect(config.key).toBe(KEY);
    expect(config.baseUrl).toBe(ROUTER);
  });

  test("re-running replaces the config atomically, leaving no temp files", async () => {
    await login(["--url", ROUTER], harness(home, { realStore: true }).deps);
    const second = harness(home, {
      stdin: "mar_live_SECONDKEYabcdef0123456789abcdefg",
      fetch: stubFetch(),
      realStore: true,
    });
    const result = await login(["--url", "https://other.example.test"], second.deps);
    expect(result).toMatchObject({ ok: true });
    const config = readConfig(configPath(home));
    expect(config.key).toBe("mar_live_SECONDKEYabcdef0123456789abcdefg");
    expect(config.baseUrl).toBe("https://other.example.test");
    expect(readdirSync(configDir({ HOME: home }))).toEqual(["config.json"]);
  });

  test("every failure branch leaves the key out of the message and all output", async () => {
    const branches: { name: string; h: Harness }[] = [
      {
        name: "401 from the router",
        h: harness(home, {
          fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }),
        }),
      },
      {
        name: "5xx from the router",
        h: harness(home, {
          fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }),
        }),
      },
      {
        name: "network error quoting the key",
        h: harness(home, {
          fetch: stubFetch({
            failWith: new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
          }),
        }),
      },
      {
        name: "write failure",
        h: harness(home, { failWrite: new Error("ENOSPC: no space left") }),
      },
      { name: "bad argv", h: harness(home) },
      { name: "malformed key", h: harness(home, { stdin: `mar_live_${"A".repeat(31)}\0` }) },
    ];
    for (const branch of branches) {
      const argv = branch.name === "bad argv" ? ["--url", KEY] : ["--url", ROUTER];
      const result = await login(argv, branch.h.deps);
      expect(result.ok).toBe(false);
      const message = result.ok === false ? (result.message ?? "") : "";
      const everything = `${message}\n${branch.h.stdout.join("\n")}`;
      expect(message).not.toContain(KEY);
      expect(branch.h.stdout.join("\n")).not.toContain(KEY);
      assertNoKeyFragment(everything, KEY);
    }
  });

  test("a fetch error quoting the key produces key-free output", async () => {
    const h = harness(home, {
      fetch: stubFetch({
        failWith: new Error(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
      }),
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("could not reach");
    expect(message).toContain("(Error)");
    expectNoKeyLeak(h, result);
  });
});

describe("REDACTED_KEY", () => {
  test("is exactly the prefix plus an ellipsis — no length hint for any key", () => {
    expect(REDACTED_KEY).toBe("mar_live_…");
  });

  test("agrees with scrub(): the printed form is a fixed point", () => {
    for (const key of [
      KEY,
      "mar_live_SECONDKEYabcdef0123456789abcdefg",
      "mar_live_ABCDEFGH",
      "mar_live_",
    ]) {
      expect(scrub(key)).toBe(REDACTED_KEY);
    }
  });
});
