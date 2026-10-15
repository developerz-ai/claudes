import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configFile, settingsFile } from "../config/paths";
import { assertNoKeyFragment } from "../test-support/redact";
import { ROUTER_UNREACHABLE_MESSAGE } from "./run";
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
    assertNoKeyFragment(text, KEY);
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
