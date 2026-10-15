import { describe, expect, test } from "bun:test";
import { assertNoKeyFragment } from "../test-support/redact";
import { errorName, type FetchLike, health, models, RouterError, scrub } from "./client";

const BASE = "https://router.example.test";
const KEY = "mar_live_TESTKEYabcdef0123456789abcdefghi";
const CAP = 2 ** 20;

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: "error" | undefined;
  signal: AbortSignal | undefined;
}

interface StubOptions {
  healthStatus?: number;
  healthBody?: string;
  modelsStatus?: number;
  modelsBody?: string;
  failWith?: Error;
  healthResponse?: Response;
}

function stubFetch(options: StubOptions = {}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect, signal: init.signal });
    if (options.failWith !== undefined) {
      throw options.failWith;
    }
    if (url.endsWith("/healthz")) {
      return (
        options.healthResponse ??
        new Response(options.healthBody ?? JSON.stringify({ version: "1.4.2" }), {
          status: options.healthStatus ?? 200,
        })
      );
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

describe("health", () => {
  test("returns the router version and sends a signal", async () => {
    const { fetchImpl, calls } = stubFetch();
    await expect(health(BASE, fetchImpl)).resolves.toBe("1.4.2");
    expect(calls[0]?.url).toBe(`${BASE}/healthz`);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("sends redirect: error", async () => {
    const { fetchImpl, calls } = stubFetch();
    await health(BASE, fetchImpl);
    expect(calls[0]?.redirect).toBe("error");
  });

  test("names the status code on a non-200", async () => {
    const { fetchImpl } = stubFetch({ healthStatus: 503, healthBody: "overloaded" });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).message).toContain("HTTP 503");
    }
  });

  test("rejects a body without a string version", async () => {
    const { fetchImpl } = stubFetch({ healthBody: JSON.stringify({ version: 7 }) });
    await expect(health(BASE, fetchImpl)).rejects.toThrow('"version"');
    const badJson = stubFetch({ healthBody: "<html>not json</html>" });
    await expect(health(BASE, badJson.fetchImpl)).rejects.toThrow("non-JSON body");
  });

  test("rejects a version string outside [0-9A-Za-z.+_-]{1,64}", async () => {
    for (const version of ["1.4.2\nSET X y", "1.4.2 hack", `${"v".repeat(65)}`, ""]) {
      const { fetchImpl } = stubFetch({ healthBody: JSON.stringify({ version }) });
      await expect(health(BASE, fetchImpl)).rejects.toThrow("invalid version string");
    }
    // The shapes the router really ships still pass through untouched.
    for (const version of ["1.4.2", "2.0.0-rc+meta", "v1_2024-01-01.5"]) {
      const { fetchImpl } = stubFetch({ healthBody: JSON.stringify({ version }) });
      await expect(health(BASE, fetchImpl)).resolves.toBe(version);
    }
  });

  test("wraps network failures without leaking the key", async () => {
    const { fetchImpl } = stubFetch({
      failWith: new Error(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
    });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      const message = (err as RouterError).message;
      expect(message).toContain(`could not reach ${BASE}/healthz (Error)`);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("invalid header value");
      assertNoKeyFragment(message, KEY);
    }
  });

  test("reports timeouts as their own error", async () => {
    const timeout = new Error("the operation timed out");
    timeout.name = "TimeoutError";
    const { fetchImpl } = stubFetch({ failWith: timeout });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).timedOut).toBe(true);
      expect((err as RouterError).message).toContain("timed out after 10s");
    }
  });

  test("the timeout really aborts: an injected timeoutMs fires the signal", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        signals.push(init.signal);
        init.signal.addEventListener("abort", () => {
          const reason = init.signal.reason;
          const aborted = new Error("the operation timed out");
          aborted.name =
            reason instanceof Error && reason.name === "TimeoutError"
              ? "TimeoutError"
              : "AbortError";
          reject(aborted);
        });
      });
    try {
      await health(BASE, fetchImpl, 25);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).timedOut).toBe(true);
      expect((err as RouterError).message).toContain("timed out after 0.025s");
    }
    expect(signals[0]?.aborted).toBe(true);
  });

  test("appends err.cause.code for socket-level failures, never the message", async () => {
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:443 — also quotes stuff"),
      { code: "ECONNREFUSED" },
    );
    const { fetchImpl } = stubFetch({ failWith: failure });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect((err as RouterError).message).toBe(`could not reach ${BASE}/healthz (ECONNREFUSED)`);
    }
  });

  test("carries tlsVerifyCode for the certificate-verification errnos, and only those", async () => {
    for (const code of [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      const failure = new TypeError("fetch failed", {
        cause: Object.assign(new Error("unable to verify the first certificate"), { code }),
      });
      const { fetchImpl } = stubFetch({ failWith: failure });
      try {
        await health(BASE, fetchImpl);
        throw new Error("expected health to throw");
      } catch (err) {
        const routerError = err as RouterError;
        expect(routerError.tlsVerifyCode).toBe(code);
        expect(routerError.timedOut).toBe(false);
        expect(routerError.message).toBe(`could not reach ${BASE}/healthz (${code})`);
      }
    }
    // A connection failure is not a certificate failure: no code, no TLS note.
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { fetchImpl } = stubFetch({ failWith: refused });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      // The instanceof check makes this fail if health() resolves (the "expected
      // health to throw" Error is not a RouterError).
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).tlsVerifyCode).toBeUndefined();
    }
  });

  test("ignores a cause code that is not an errno-looking token", async () => {
    for (const code of ["not a code", "lower_case", "X", `BAD${"X".repeat(64)}`, "OK; rm -rf /"]) {
      const failure = new TypeError("fetch failed");
      (failure as { cause?: unknown }).cause = { code };
      const { fetchImpl } = stubFetch({ failWith: failure });
      await expect(health(BASE, fetchImpl)).rejects.toThrow(
        `could not reach ${BASE}/healthz (TypeError)`,
      );
    }
  });

  test("a refused redirect is named, never quoted (Node shape: the cause says it)", async () => {
    // The shape Node's undici really rejects with (probed on Node 24): a bare
    // "fetch failed" TypeError whose code-less cause is exactly "unexpected redirect".
    const { fetchImpl } = stubFetch({
      failWith: new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
    });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      const message = (err as RouterError).message;
      expect(message).toBe(`could not reach ${BASE}/healthz (refused a redirect)`);
      expect(message).not.toContain("unexpected redirect");
      assertNoKeyFragment(message, KEY);
    }
  });

  test("an errno wins over the word 'redirect' in a DNS or TLS cause (no misdiagnosis)", async () => {
    // A hostname or certificate SAN can contain "redirect"; the real code must still show.
    const cases: Array<[string, string]> = [
      ["getaddrinfo ENOTFOUND redirect.example.test", "ENOTFOUND"],
      [
        "Hostname/IP does not match certificate's altnames: DNS:redirect.test",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ],
    ];
    for (const [text, code] of cases) {
      const failure = new TypeError("fetch failed", {
        cause: Object.assign(new Error(text), { code }),
      });
      const { fetchImpl } = stubFetch({ failWith: failure });
      await expect(health(BASE, fetchImpl)).rejects.toThrow(
        `could not reach ${BASE}/healthz (${code})`,
      );
    }
  });

  test("a code-less cause that merely mentions redirect is not a refused redirect", async () => {
    const failure = new TypeError("fetch failed", {
      cause: new Error("something about redirect.example"),
    });
    const { fetchImpl } = stubFetch({ failWith: failure });
    await expect(health(BASE, fetchImpl)).rejects.toThrow(
      `could not reach ${BASE}/healthz (TypeError)`,
    );
  });

  test("a refused redirect is named, never quoted (Bun shape: the message says it)", async () => {
    const { fetchImpl } = stubFetch({
      failWith: new TypeError(`redirect mode is set to error: ${KEY}`),
    });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      const message = (err as RouterError).message;
      expect(message).toBe(`could not reach ${BASE}/healthz (refused a redirect)`);
      assertNoKeyFragment(message, KEY);
    }
  });

  test("an exotic thrown value (prototype trap) still becomes a RouterError, key-free", async () => {
    // A proxy whose getPrototypeOf trap throws makes every `instanceof` check
    // throw; the diagnostic guard must still produce a RouterError.
    const failure = new Proxy(new TypeError("fetch failed"), {
      getPrototypeOf() {
        throw new Error(`trap exploded ${KEY}`);
      },
    });
    const { fetchImpl } = stubFetch({ failWith: failure });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      const message = (err as RouterError).message;
      expect(message).toBe(`could not reach ${BASE}/healthz (Error)`);
      assertNoKeyFragment(message, KEY);
    }
  });

  test("a throwing err.cause getter never escapes the diagnostic", async () => {
    const failure = new TypeError("fetch failed");
    Object.defineProperty(failure, "cause", {
      get() {
        throw new Error("the cause getter exploded");
      },
    });
    const { fetchImpl } = stubFetch({ failWith: failure });
    await expect(health(BASE, fetchImpl)).rejects.toThrow(
      `could not reach ${BASE}/healthz (TypeError)`,
    );
  });

  test("a cause whose code getter throws falls back to the class name", async () => {
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = {
      get code(): string {
        throw new Error("the code getter exploded");
      },
    };
    const { fetchImpl } = stubFetch({ failWith: failure });
    await expect(health(BASE, fetchImpl)).rejects.toThrow(
      `could not reach ${BASE}/healthz (TypeError)`,
    );
  });

  test("refuses a body whose declared content-length exceeds the 1 MiB cap", async () => {
    const { fetchImpl } = stubFetch({
      healthResponse: {
        status: 200,
        headers: new Headers({ "content-length": String(CAP + 1) }),
        body: null,
      } as unknown as Response,
    });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect((err as RouterError).message).toContain(`exceeds ${CAP} bytes`);
      expect((err as RouterError).message).not.toContain("timed out");
    }
  });

  test("refuses a streamed body that grows past the cap mid-read", async () => {
    const chunk = "a".repeat(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const { fetchImpl } = stubFetch({ healthResponse: new Response(stream, { status: 200 }) });
    await expect(health(BASE, fetchImpl)).rejects.toThrow(`exceeds ${CAP} bytes`);
  });
});

describe("models", () => {
  test("returns data[].id with the key only in the Authorization header", async () => {
    const { fetchImpl, calls } = stubFetch();
    await expect(models(BASE, KEY, fetchImpl)).resolves.toEqual([
      "claude-opus-4-1",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/v1/models`);
    expect(call?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.redirect).toBe("error");
  });

  test("names the status code on 401/403 and never the key", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = stubFetch({ modelsStatus: status, modelsBody: "unauthorized" });
      try {
        await models(BASE, KEY, fetchImpl);
        throw new Error("expected models to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RouterError);
        expect((err as RouterError).status).toBe(status);
        expect((err as RouterError).message).toContain(`HTTP ${status}`);
        expect((err as RouterError).message).not.toContain(KEY);
      }
    }
  });

  test("rejects malformed bodies", async () => {
    const missing = stubFetch({ modelsBody: JSON.stringify({ object: "list" }) });
    await expect(models(BASE, KEY, missing.fetchImpl)).rejects.toThrow('"data" array');
    const badEntry = stubFetch({ modelsBody: JSON.stringify({ data: [{ id: 42 }] }) });
    await expect(models(BASE, KEY, badEntry.fetchImpl)).rejects.toThrow("malformed model entry");
  });

  test("a fetch error quoting the key in its message never reaches the error text", async () => {
    const { fetchImpl } = stubFetch({
      failWith: new TypeError(`Headers.append: "Bearer ${KEY}" is an invalid header value`),
    });
    try {
      await models(BASE, KEY, fetchImpl);
      throw new Error("expected models to throw");
    } catch (err) {
      const message = (err as RouterError).message;
      expect(message).toBe(`could not reach ${BASE}/v1/models (TypeError)`);
      expect(message).not.toContain(KEY);
      assertNoKeyFragment(message, KEY);
    }
  });
});

describe("scrub", () => {
  test("replaces anything after mar_live_ up to whitespace with an ellipsis", () => {
    expect(scrub(`Bearer ${KEY} went out`)).toBe("Bearer mar_live_… went out");
    expect(scrub(`two: ${KEY} and ${KEY}!`)).toBe("two: mar_live_… and mar_live_…");
    expect(scrub("no keys here")).toBe("no keys here");
  });

  test("RouterError scrubs its own message at construction", () => {
    const err = new RouterError(`GET x failed with ${KEY} inside`);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("mar_live_…");
  });
});

describe("errorName", () => {
  test("returns class-shaped names, Error for everything else", () => {
    expect(errorName(new TypeError("x"))).toBe("TypeError");
    expect(errorName(new RangeError("x"))).toBe("RangeError");
    expect(errorName("a plain string")).toBe("Error");
    expect(errorName(undefined)).toBe("Error");
    for (const name of [
      "lower case",
      "4StartsWithADigit",
      "With Space",
      "Bad!Name",
      "",
      `x${"N".repeat(63)}`,
    ]) {
      const err = new Error("x");
      err.name = name;
      expect(errorName(err)).toBe("Error");
    }
    const throwing = new Error("x");
    Object.defineProperty(throwing, "name", {
      get() {
        throw new Error("boom");
      },
    });
    expect(errorName(throwing)).toBe("Error");
    const nonString = new Error("x");
    Object.defineProperty(nonString, "name", { value: 42 });
    expect(errorName(nonString)).toBe("Error");
  });

  test("a non-class-shaped err.name prints as plain Error in the unreachable message", async () => {
    const failure = new Error("fetch failed");
    failure.name = "suspicious name; rm -rf /";
    const { fetchImpl } = stubFetch({ failWith: failure });
    await expect(health(BASE, fetchImpl)).rejects.toThrow(
      `could not reach ${BASE}/healthz (Error)`,
    );
  });
});
