import { describe, expect, test } from "bun:test";
import { KEY, ROUTER } from "../test-support/fixtures";
import { type Config, configSchema, keySchema, ROUTER_KEY_PATTERN } from "./schema";

function sampleConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: ROUTER,
    key: KEY,
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    ...overrides,
  };
}

describe("configSchema", () => {
  test("accepts a complete config, and the optional fields", () => {
    expect(configSchema.safeParse(sampleConfig()).success).toBe(true);
    expect(
      configSchema.safeParse(
        sampleConfig({ subagentModel: "claude-haiku-4-5", maxContextTokens: 200_000 }),
      ).success,
    ).toBe(true);
  });

  test("rejects the wrong version and a bad key", () => {
    expect(configSchema.safeParse(sampleConfig({ version: 2 as Config["version"] })).success).toBe(
      false,
    );
    expect(configSchema.safeParse(sampleConfig({ key: "sk-not-a-router-key" })).success).toBe(
      false,
    );
    expect(configSchema.safeParse(sampleConfig({ key: "mar_live_" })).success).toBe(false);
  });

  test("rejects maxContextTokens that is not a positive integer", () => {
    expect(configSchema.safeParse(sampleConfig({ maxContextTokens: 0 })).success).toBe(false);
    expect(configSchema.safeParse(sampleConfig({ maxContextTokens: 1.5 })).success).toBe(false);
    expect(configSchema.safeParse(sampleConfig({ maxContextTokens: -5 })).success).toBe(false);
  });
});

describe("keySchema / ROUTER_KEY_PATTERN", () => {
  test("accepts mar_live_ plus exactly 32 [A-Za-z0-9_-] characters", () => {
    expect(keySchema.safeParse(`mar_live_${"A".repeat(32)}`).success).toBe(true);
    expect(keySchema.safeParse(`mar_live_aB0-_xYz9${"0".repeat(23)}`).success).toBe(true);
  });

  test("rejects wrong lengths", () => {
    expect(ROUTER_KEY_PATTERN.test(`mar_live_${"A".repeat(31)}`)).toBe(false);
    expect(ROUTER_KEY_PATTERN.test(`mar_live_${"A".repeat(33)}`)).toBe(false);
    expect(ROUTER_KEY_PATTERN.test(`mar_live_${"A".repeat(64)}`)).toBe(false);
  });

  test("rejects control bytes, spaces, and non-ASCII anywhere in the value", () => {
    for (const bad of [
      `mar_live_${"A".repeat(31)}\0`,
      `mar_live_${"A".repeat(31)}\r`,
      `mar_live_${"A".repeat(31)}\t`,
      `mar_live_${"A".repeat(31)} `,
      ` mar_live_${"A".repeat(32)}`,
      `mar_live_${"A".repeat(16)} ${"A".repeat(15)}`,
      `mar_live_${"A".repeat(16)}é${"A".repeat(15)}`,
      "mar_live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]) {
      expect(ROUTER_KEY_PATTERN.test(bad)).toBe(false);
      expect(keySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("baseUrlSchema (via configSchema)", () => {
  const goodUrls = [
    "https://router.example.com",
    "https://router.example.com:8443",
    "http://127.0.0.1",
    "http://127.0.0.1:3000",
    "http://localhost",
    "http://[::1]:8080",
  ];
  const badUrls = [
    "http://router.example.com", // plain http, non-loopback
    "http://192.168.1.10",
    "ftp://router.example.com",
    "not a url at all",
    "https://router.example.com/", // trailing slash
    "https://router.example.com/api", // path
    "https://router.example.com?x=1", // query
    "https://router.example.com#frag", // fragment
    "https://key:secret@router.example.com", // credentials
    "https://x?", // empty query — the URL parser swallows it, the origin check does not
    "https://x#", // empty fragment
    " https://x", // leading whitespace — silently trimmed by the parser
    "https://x\n", // trailing newline
    "https:evil.com", // scheme-relative-looking host
    "https://x:443", // explicit default port
  ];

  test("accepts https anywhere and http only on loopback", () => {
    for (const baseUrl of goodUrls) {
      expect(configSchema.safeParse(sampleConfig({ baseUrl })).success).toBe(true);
    }
  });

  test("rejects non-https, paths, queries, fragments, credentials, slashes", () => {
    for (const baseUrl of badUrls) {
      const result = configSchema.safeParse(sampleConfig({ baseUrl }));
      expect(result.success).toBe(false);
    }
  });
});
