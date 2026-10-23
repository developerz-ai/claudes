import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "./login";
import { parseLoginArgs } from "./login-args";
import { configPath, harness, KEY, ROUTER } from "./login-harness";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-login-args-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("login argument handling", () => {
  test("missing --url prints usage on stderr path and exits 64", async () => {
    const h = harness(home);
    const result = await login([], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    expect(result.ok === false && result.message).toContain("usage: claudes login --url");
    expect(existsSync(configPath(home))).toBe(false);
  });

  test("refuses --key (and --key=…) with exit 64, without echoing the key", async () => {
    for (const argv of [
      ["--url", ROUTER, "--key", KEY],
      [`--url=${ROUTER}`, `--key=${KEY}`],
    ]) {
      const h = harness(home);
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
      const h = harness(home);
      const result = await login(argv, h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("looks like a router key");
      expect(message).not.toContain(KEY);
      expect(h.prompts).toEqual([]);
    }
  });

  test("a flag-shaped next token is a missing value, rejected by the requiring flag's name", () => {
    const cases: Array<[readonly string[], string]> = [
      [["--url", ROUTER, "--opus", "--haiku", "claude-haiku-4-5"], "--opus"],
      [["--url", ROUTER, "--sonnet", "--opus", "claude-opus-5-5"], "--sonnet"],
      [["--url", "--opus"], "--url"],
      [["--url", "--haiku", "claude-haiku-4-5"], "--url"],
    ];
    for (const [argv, flag] of cases) {
      const result = parseLoginArgs(argv);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      // USAGE itself names every flag, so only the first line can assert the
      // rejection names the requiring flag and nothing else.
      const lede = result.ok === false ? (result.message ?? "").split("\n\n")[0] : "";
      expect(lede).toBe(`claudes login: ${flag} requires a value`);
    }
  });

  test("a flag-shaped inline value (--x=--y) is also a missing value", () => {
    for (const [argv, flag] of [
      [["--url=--opus"], "--url"],
      [[`--url=${ROUTER}`, "--opus=--haiku"], "--opus"],
    ] as Array<[readonly string[], string]>) {
      const result = parseLoginArgs(argv);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const lede = result.ok === false ? (result.message ?? "").split("\n\n")[0] : "";
      expect(lede).toBe(`claudes login: ${flag} requires a value`);
    }
  });

  test("a key-shaped value still gets the key-refusal message, not the missing-value one", () => {
    for (const argv of [
      ["--url", ROUTER, "--opus", KEY],
      ["--url", KEY],
    ]) {
      const result = parseLoginArgs(argv);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("looks like a router key");
      expect(message).not.toContain("requires a value");
      expect(message).not.toContain(KEY);
    }
  });

  test("valid model ids and a valid https --url remain accepted, next-token and inline", () => {
    const result = parseLoginArgs([
      "--url",
      ROUTER,
      "--opus",
      "claude-opus-5-5",
      "--sonnet=claude-sonnet-5-0",
      "--haiku",
      "claude-haiku-4-5",
    ]);
    expect(result).toEqual({
      ok: true,
      args: {
        url: ROUTER,
        overrides: {
          opus: "claude-opus-5-5",
          sonnet: "claude-sonnet-5-0",
          haiku: "claude-haiku-4-5",
        },
      },
    });
    const inlineUrl = parseLoginArgs([`--url=${ROUTER}`]);
    expect(inlineUrl).toEqual({ ok: true, args: { url: ROUTER, overrides: {} } });
  });

  test("rejects an invalid --url before any I/O, without echoing the value", async () => {
    const h = harness(home);
    const result = await login(["--url", "https://x?not-a-key-but-secret"], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("invalid --url (baseUrl must be a bare origin");
    expect(message).toContain("did you mean https://x?");
    expect(message).not.toContain("not-a-key-but-secret");
    expect(h.stdout.length).toBe(0);
    expect(h.prompts).toEqual([]);
  });

  test("an --url that is not a URL at all gets no origin hint", async () => {
    const h = harness(home);
    const result = await login(["--url", "definitely not a url"], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("invalid --url (baseUrl must be a valid https:// URL");
    expect(message).not.toContain("did you mean");
    expect(message).not.toContain("definitely not a url");
  });

  test("an already-bare-origin-but-http --url gets no hint (it would echo the input)", async () => {
    const h = harness(home);
    const result = await login(["--url", "http://router.lan"], h.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 64 });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain("invalid --url");
    expect(message).toContain("must use https://");
    expect(message).not.toContain("did you mean");
  });

  test("opaque origins (file:, data:, javascript:) get no hint and never print null", async () => {
    for (const url of ["file:///etc/passwd", "data:text/plain,hello", "javascript:alert(1)"]) {
      const h = harness(home);
      const result = await login(["--url", url], h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("invalid --url");
      expect(message).not.toContain("did you mean");
      expect(message).not.toContain("null");
      expect(message).not.toContain(url);
    }
  });

  test("a host that embeds the key prefix (%5F-encoded or uppercased) gets no hint", async () => {
    const body = "FAKEKEYabcdef0123456789abcdefghi";
    for (const url of [
      `https://mar%5Flive_${body}.example.test`,
      `https://MAR_LIVE_${body}.example.test`,
    ]) {
      const h = harness(home);
      const result = await login(["--url", url], h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("invalid --url");
      // The URL parser decodes %5F and lowercases hosts, so the suppression
      // branch must fire before the origin could be offered back.
      expect(message).not.toContain("did you mean");
      expect(message).not.toContain("FAKEKEY");
      expect(message).not.toContain("mar_live_");
    }
  });

  test("a duplicate --url is refused by flag name, never by value", async () => {
    for (const argv of [
      ["--url", ROUTER, "--url", "https://other.example.test"],
      [`--url=${ROUTER}`, "--url", "https://other.example.test"],
    ]) {
      const h = harness(home);
      const result = await login(argv, h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message.split("\n\n")[0]).toBe("claudes login: --url may only be given once");
      expect(message).not.toContain("other.example.test");
      expect(h.prompts).toEqual([]);
      expect(h.fetchCalls).toEqual([]);
    }
  });

  test("refuses a tier override that is not a bounded model id, without echoing it", async () => {
    for (const bad of ["has space", "tab\there", "x".repeat(101), "quote'\"id"]) {
      const h = harness(home);
      const result = await login(["--url", ROUTER, "--opus", bad], h.deps);
      expect(result).toMatchObject({ ok: false, exitCode: 64 });
      const message = result.ok === false ? (result.message ?? "") : "";
      expect(message).toContain("--opus is not a valid model id");
      expect(message).not.toContain(bad.trim());
      expect(h.prompts).toEqual([]);
      expect(h.fetchCalls).toEqual([]);
    }
  });

  test("unexpected and unknown arguments are named by position, never by value", async () => {
    const positional = harness(home);
    const positionalResult = await login(["--url", ROUTER, "s3cret-positional"], positional.deps);
    expect(positionalResult).toMatchObject({ ok: false, exitCode: 64 });
    expect(positionalResult.ok === false && positionalResult.message).toContain(
      "unexpected argument #3",
    );
    expect(positionalResult.ok === false && positionalResult.message).not.toContain(
      "s3cret-positional",
    );

    const unknown = harness(home);
    const unknownResult = await login(["--url", ROUTER, "--s3cret-flag", "v"], unknown.deps);
    expect(unknownResult).toMatchObject({ ok: false, exitCode: 64 });
    expect(unknownResult.ok === false && unknownResult.message).toContain("unknown option #3");
    expect(unknownResult.ok === false && unknownResult.message).not.toContain("s3cret-flag");
  });
});
