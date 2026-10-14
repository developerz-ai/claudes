import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir } from "../config/paths";
import { readConfig } from "../config/store";
import { scrub } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import { type LoginDeps, login, redactKey } from "./login";
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

describe("login validation and output", () => {
  test("health failure names the endpoint and exits 1", async () => {
    const h = harness(home, {
      fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }).fetchImpl,
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.ok === false && result.message).toContain("HTTP 503");
    expectNoKeyLeak(h, result);
  });

  test("models 401 maps to 'router rejected the key'", async () => {
    const h = harness(home, {
      fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }).fetchImpl,
    });
    const result = await login(["--url", ROUTER], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("router rejected the key");
    expect(message).toContain("401");
    expectNoKeyLeak(h, result);
  });

  test("an invalid router version string is refused, not printed", async () => {
    const h = harness(home, {
      fetch: stubFetch({ healthBody: JSON.stringify({ version: "1.4.2\nrm -rf /" }) }).fetchImpl,
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
      fetch: stubFetch().fetchImpl,
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
          fetch: stubFetch({ modelsStatus: 401, modelsBody: "denied" }).fetchImpl,
        }),
      },
      {
        name: "5xx from the router",
        h: harness(home, {
          fetch: stubFetch({ healthStatus: 503, healthBody: "overloaded" }).fetchImpl,
        }),
      },
      {
        name: "network error quoting the key",
        h: harness(home, {
          fetch: stubFetch({
            failWith: new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
          }).fetchImpl,
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
      const everything = `${message}\n${branch.h.stdout.join("\n")}\n${branch.h.stderr.join("\n")}`;
      expect(message).not.toContain(KEY);
      expect(branch.h.stdout.join("\n")).not.toContain(KEY);
      expect(branch.h.stderr.join("\n")).not.toContain(KEY);
      assertNoKeyFragment(everything, KEY);
    }
  });

  test("a fetch error quoting the key produces key-free output", async () => {
    const h = harness(home, {
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
  test("every key — long or short, valid or not — redacts to exactly the prefix", () => {
    expect(redactKey(KEY)).toBe("mar_live_…");
    expect(redactKey("mar_live_ABCDEFGH")).toBe("mar_live_…");
    expect(redactKey("mar_live_ABCD")).toBe("mar_live_…");
    expect(redactKey("mar_live_")).toBe("mar_live_…");
    expect(redactKey("mar_live")).toBe("mar_live_…");
  });

  test("agrees with scrub(): the printed form is a fixed point", () => {
    for (const key of [KEY, "mar_live_SECONDKEYabcdef0123456789abcdefg"]) {
      expect(redactKey(key)).toBe(scrub(key));
    }
  });
});
