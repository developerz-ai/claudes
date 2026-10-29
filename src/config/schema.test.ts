import { describe, expect, test } from "bun:test";
import { KEY, ROUTER } from "../test-support/fixtures";
import { assertNoKeyFragment } from "../test-support/redact";
import {
  baseUrlSchema,
  type Config,
  configSchema,
  formatZodIssues,
  KEY_FRAGMENT_WINDOW,
  keyFragmentOffset,
  keySchema,
  ROUTER_KEY_PATTERN,
  ROUTER_KEY_PREFIX,
} from "./schema";

/**
 * A synthetic key whose body has 32 distinct characters. A body that repeats
 * itself (the shared fixture does) lets an EARLIER overlapping window match
 * first, so an "offset N" expectation would be off by one.
 */
const DISTINCT_KEY = `${ROUTER_KEY_PREFIX}${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"}`;
const DISTINCT_BODY = DISTINCT_KEY.slice(ROUTER_KEY_PREFIX.length);

/** The body length the router issues: the shared fixture key minus its prefix. */
const BODY_LENGTH = KEY.length - ROUTER_KEY_PREFIX.length;

/** Every character a router key body may carry. */
const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

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

describe("keyFragmentOffset — the leak window", () => {
  test("returns the body offset of the first window it finds", () => {
    const fragment = DISTINCT_BODY.slice(10, 10 + KEY_FRAGMENT_WINDOW);
    expect(keyFragmentOffset(`the key leaked: ${fragment} here`, DISTINCT_KEY)).toBe(10);
  });

  test("returns undefined when the text carries no window of the body", () => {
    expect(keyFragmentOffset("the router refused the request", DISTINCT_KEY)).toBeUndefined();
  });

  test("the whole key is a match at offset 0", () => {
    expect(keyFragmentOffset(KEY, KEY)).toBe(0);
  });

  test("a fragment of KEY_FRAGMENT_WINDOW characters matches, one shorter does not", () => {
    expect(KEY_FRAGMENT_WINDOW).toBe(8);
    const exact = DISTINCT_BODY.slice(0, KEY_FRAGMENT_WINDOW);
    const shorter = DISTINCT_BODY.slice(0, KEY_FRAGMENT_WINDOW - 1);
    expect(keyFragmentOffset(exact, DISTINCT_KEY)).toBe(0);
    expect(keyFragmentOffset(shorter, DISTINCT_KEY)).toBeUndefined();
  });

  test("a window at the end of the body is found at its own offset", () => {
    const offset = DISTINCT_BODY.length - KEY_FRAGMENT_WINDOW;
    const tail = DISTINCT_BODY.slice(offset);
    expect(keyFragmentOffset(tail, DISTINCT_KEY)).toBe(offset);
  });

  test("the bare prefix is not a window, but a prefix-less body fragment is", () => {
    // The bare prefix is the doctor's live gate's own rule
    // (src/doctor/checks/live.ts); this window rule covers the body only.
    expect(keyFragmentOffset(ROUTER_KEY_PREFIX, DISTINCT_KEY)).toBeUndefined();
    const bodyOnly = DISTINCT_BODY.slice(0, KEY_FRAGMENT_WINDOW);
    expect(keyFragmentOffset(bodyOnly, DISTINCT_KEY)).toBe(0);
  });

  test("a body shorter than the window can never match", () => {
    const shortKey = `${ROUTER_KEY_PREFIX}${"A".repeat(KEY_FRAGMENT_WINDOW - 1)}`;
    const text = "A".repeat(KEY_FRAGMENT_WINDOW - 1);
    expect(keyFragmentOffset(text, shortKey)).toBeUndefined();
  });
});

describe("formatZodIssues", () => {
  test("a root-level issue renders as the message alone, with no leading separator", () => {
    const result = baseUrlSchema.safeParse("not a url");
    if (result.success) {
      throw new Error("expected baseUrlSchema to reject a non-URL");
    }
    const [issue] = result.error.issues;
    if (!issue) {
      throw new Error("expected exactly one issue");
    }
    expect(issue.path).toEqual([]);
    const reason = formatZodIssues(result.error);
    expect(reason).toBe(issue.message);
    expect(reason.startsWith(": ")).toBe(false);
  });

  test("a pathed issue renders as 'path: message'", () => {
    const result = configSchema.safeParse(sampleConfig({ key: "sk-not-a-router-key" }));
    if (result.success) {
      throw new Error("expected the config parse to fail");
    }
    const [issue] = result.error.issues;
    if (!issue) {
      throw new Error("expected exactly one issue");
    }
    expect(issue.path.join(".")).toBe("key");
    const reason = formatZodIssues(result.error);
    expect(reason).toBe(`key: ${issue.message}`);
  });

  test("a nested path joins with '.'", () => {
    const tiers = { opus: "", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" };
    const result = configSchema.safeParse(sampleConfig({ tiers }));
    if (result.success) {
      throw new Error("expected the config parse to fail");
    }
    const [issue] = result.error.issues;
    if (!issue) {
      throw new Error("expected exactly one issue");
    }
    expect(issue.path.join(".")).toBe("tiers.opus");
    expect(formatZodIssues(result.error)).toBe(`tiers.opus: ${issue.message}`);
  });

  test("several issues join with '; ' in the order zod reports them", () => {
    const tiers = { opus: "", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" };
    const result = configSchema.safeParse(sampleConfig({ key: "sk-not-a-router-key", tiers }));
    if (result.success) {
      throw new Error("expected the config parse to fail");
    }
    const issues = result.error.issues;
    expect(issues.length).toBe(2);
    const [keyIssue, tiersIssue] = issues;
    if (!keyIssue || !tiersIssue) {
      throw new Error("expected two issues");
    }
    const reason = formatZodIssues(result.error);
    expect(reason).toContain("; ");
    expect(reason).toBe(`key: ${keyIssue.message}; tiers.opus: ${tiersIssue.message}`);
  });

  test("a failing key is never echoed back", () => {
    // One character short of a whole key, so the schema refuses it — and the
    // reason must carry neither the key nor any window of its body.
    const badKey = `${ROUTER_KEY_PREFIX}${"0123456789abcdefghijklmnopqrstu"}`;
    const result = configSchema.safeParse(sampleConfig({ key: badKey }));
    if (result.success) {
      throw new Error("expected the config parse to fail");
    }
    const reason = formatZodIssues(result.error);
    expect(reason).not.toContain(badKey);
    assertNoKeyFragment(reason, badKey);
  });

  test("a baseUrl carrying key material is not echoed back", () => {
    // The rendered reason is static text, so the probe below shows exactly
    // which characters a reason can carry. Every other character is safe to
    // build a key body from — as long as the real reason introduces no
    // character the probe did not, which the first loop below pins.
    const probeUrl = `https://router.example.test/${ROUTER_KEY_PREFIX}probe`;
    const probe = baseUrlSchema.safeParse(probeUrl);
    if (probe.success) {
      throw new Error("expected the baseUrl to be rejected");
    }
    const printed = new Set(formatZodIssues(probe.error));
    const alphabet = KEY_ALPHABET.split("");
    const free = alphabet.filter((char) => !printed.has(char));
    if (free.length < BODY_LENGTH) {
      throw new Error("expected enough characters outside the rendered reason");
    }
    const body = free.slice(0, BODY_LENGTH).join("");
    const key = `${ROUTER_KEY_PREFIX}${body}`;
    const baseUrl = `https://router.example.test/${key}`;

    const result = baseUrlSchema.safeParse(baseUrl);
    if (result.success) {
      throw new Error("expected the baseUrl to be rejected");
    }
    const reason = formatZodIssues(result.error);
    for (const char of reason) {
      expect(printed.has(char)).toBe(true);
    }
    expect(reason).not.toContain(baseUrl);
    expect(reason).not.toContain(key);
    expect(reason).not.toContain(ROUTER_KEY_PREFIX);
    for (const char of body) {
      expect(reason).not.toContain(char);
    }
    assertNoKeyFragment(reason, key);
  });
});
