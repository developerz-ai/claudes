import { describe, expect, test } from "bun:test";
import { ROUTER_KEY_PATTERN, ROUTER_KEY_PREFIX } from "../config/schema";
import { KEY, ROUTER } from "../test-support/fixtures";
import { assertNoKeyFragment } from "../test-support/redact";
import { errorName, type FetchLike, health, models, RouterError, scrub } from "./client";

const BASE = ROUTER;
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
  modelsResponse?: Response;
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
    if (options.modelsResponse !== undefined) {
      return options.modelsResponse;
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
      // A router that answered with a failure is not a router that answered
      // without a usable version.
      expect((err as RouterError).invalidVersion).toBe(false);
    }
  });

  test("rejects a body without a string version", async () => {
    for (const version of [7, { raw: KEY }]) {
      const { fetchImpl } = stubFetch({ healthBody: JSON.stringify({ version }) });
      try {
        await health(BASE, fetchImpl);
        throw new Error("expected health to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RouterError);
        const routerError = err as RouterError;
        expect(routerError.invalidVersion).toBe(true);
        expect(routerError.message).toContain('"version"');
        // The payload can carry key material; the refusal relays none of it.
        expect(routerError.message).not.toContain("FAKEKEYabcdef");
        assertNoKeyFragment(routerError.message, KEY);
      }
    }
    // A body that is not JSON at all is the same failure: the probe answered,
    // the payload was unusable.
    const badJson = stubFetch({ healthBody: "<html>not json</html>" });
    try {
      await health(BASE, badJson.fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      const routerError = err as RouterError;
      expect(routerError.invalidVersion).toBe(true);
      expect(routerError.message).toContain("non-JSON body");
      // The body is the router's own bytes: the refusal relays none of it.
      assertNoKeyFragment(routerError.message, KEY);
    }
  });

  test("rejects a version string outside [0-9A-Za-z.+_-]{1,64}", async () => {
    for (const version of ["1.4.2\nSET X y", "1.4.2 hack", "v".repeat(65), "", `${KEY}\n`]) {
      const { fetchImpl } = stubFetch({ healthBody: JSON.stringify({ version }) });
      try {
        await health(BASE, fetchImpl);
        throw new Error("expected health to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RouterError);
        const routerError = err as RouterError;
        expect(routerError.invalidVersion).toBe(true);
        expect(routerError.message).toContain("invalid version string");
        // The version is the router's own text: never relayed, never scrubbed
        // into the refusal.
        if (version !== "") {
          expect(routerError.message).not.toContain(version);
        }
        assertNoKeyFragment(routerError.message, KEY);
      }
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

  test("an errno wins when the cause mentions redirect, and even when it is the exact redirect phrase", async () => {
    // A hostname or certificate SAN can contain "redirect"; the real code must
    // still show — including when the cause is exactly "unexpected redirect"
    // but carries an errno anyway.
    const cases: Array<[string, string]> = [
      ["getaddrinfo ENOTFOUND redirect.example.test", "ENOTFOUND"],
      [
        "Hostname/IP does not match certificate's altnames: DNS:redirect.test",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ],
      ["unexpected redirect", "ECONNREFUSED"],
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

  test("a code-less cause that only starts like the redirect phrase is a plain TypeError", async () => {
    // "unexpected redirect to <url>": the phrase plus anything — a URL, or a
    // key an attacker smuggled into the message — is not the exact bare cause.
    const failure = new TypeError("fetch failed", {
      cause: new Error(`unexpected redirect to ${BASE}/login?next=${KEY}`),
    });
    const { fetchImpl } = stubFetch({ failWith: failure });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      const message = (err as RouterError).message;
      expect(message).toBe(`could not reach ${BASE}/healthz (TypeError)`);
      assertNoKeyFragment(message, KEY);
    }
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

  test("the Bun shapes: UnexpectedRedirect is a refused redirect, ConnectionRefused is not", async () => {
    const redirect = stubFetch({
      failWith: new TypeError(`UnexpectedRedirect fetching "${BASE}/healthz"`),
    });
    try {
      await health(BASE, redirect.fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect((err as RouterError).message).toBe(
        `could not reach ${BASE}/healthz (refused a redirect)`,
      );
    }
    // A connection failure whose URL merely contains "redirect" is reported by
    // its class name; the word alone must not tip the diagnosis.
    const refused = stubFetch({
      failWith: new TypeError(`ConnectionRefused fetching "${BASE}/redirect"`),
    });
    await expect(health(BASE, refused.fetchImpl)).rejects.toThrow(
      `could not reach ${BASE}/healthz (TypeError)`,
    );
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

  test("a body-read rejection from a prototype-trapping proxy still becomes a RouterError", async () => {
    // The reader rejects with a proxy whose getPrototypeOf trap throws: with a
    // bare instanceof in the body-read handler the proxy itself would escape
    // health() raw, breaking the every-failure-is-a-RouterError contract.
    const trap = new Proxy(new Error("fetch failed"), {
      getPrototypeOf() {
        throw new Error(`trap exploded ${KEY}`);
      },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(trap);
      },
    });
    const { fetchImpl } = stubFetch({ healthResponse: new Response(stream, { status: 200 }) });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      const message = (err as RouterError).message;
      expect(message).toBe(`GET ${BASE}/healthz body could not be read (Error)`);
      // An unrelated body-read failure stays an unreadable body — never a timeout.
      expect((err as RouterError).timedOut).toBe(false);
      assertNoKeyFragment(message, KEY);
    }
  });

  test("a timeout-shaped body-read rejection is the injected-budget timeout", async () => {
    // A stall after the headers classifies exactly like a pre-headers stall:
    // same timedOut flag, same message shape, same budget (25 ms → "0.025s").
    // Both abort-shape names matter — see isTimeoutName's two classification
    // sites in client.ts.
    for (const name of ["TimeoutError", "AbortError"]) {
      const failure = new Error("the operation timed out");
      failure.name = name;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(failure);
        },
      });
      const { fetchImpl } = stubFetch({ healthResponse: new Response(stream, { status: 200 }) });
      try {
        await health(BASE, fetchImpl, 25);
        throw new Error("expected health to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RouterError);
        expect((err as RouterError).timedOut).toBe(true);
        expect((err as RouterError).message).toBe(`GET ${BASE}/healthz timed out after 0.025s`);
        assertNoKeyFragment((err as RouterError).message, KEY);
      }
    }
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

  test("a non-JSON body is not an unusable version: only /healthz answers that", async () => {
    // /v1/models carries no version, so the flag stays with the health probe:
    // a model list that is not JSON says nothing about a version.
    const { fetchImpl } = stubFetch({ modelsBody: "<html>not json</html>" });
    try {
      await models(BASE, KEY, fetchImpl);
      throw new Error("expected models to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      const routerError = err as RouterError;
      expect(routerError.invalidVersion).toBe(false);
      expect(routerError.message).toContain("non-JSON body");
      assertNoKeyFragment(routerError.message, KEY);
    }
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

  test("a timeout-shaped body-read rejection is the injected-budget timeout", async () => {
    // Same classification as health: the budget threads through to the body
    // read, and both abort-shape names count.
    for (const name of ["TimeoutError", "AbortError"]) {
      const failure = new Error("the operation timed out");
      failure.name = name;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(failure);
        },
      });
      const { fetchImpl } = stubFetch({ modelsResponse: new Response(stream, { status: 200 }) });
      try {
        await models(BASE, KEY, fetchImpl, 25);
        throw new Error("expected models to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RouterError);
        expect((err as RouterError).timedOut).toBe(true);
        expect((err as RouterError).message).toBe(`GET ${BASE}/v1/models timed out after 0.025s`);
        assertNoKeyFragment((err as RouterError).message, KEY);
      }
    }
  });
});

describe("unread response disposal", () => {
  for (const endpoint of ["health", "models"] as const) {
    const path = endpoint === "health" ? "/healthz" : "/v1/models";
    for (const refusal of ["non-200", "declared oversize"] as const) {
      const status = refusal === "declared oversize" ? 200 : endpoint === "health" ? 503 : 401;
      const message =
        refusal === "non-200"
          ? `GET ${BASE}${path} failed: HTTP ${status}`
          : `GET ${BASE}${path} response body exceeds ${CAP} bytes`;

      for (const disposal of ["success", "reject", "throw", "null body"] as const) {
        test(`${endpoint}: ${refusal} preserves its error with ${disposal} disposal`, async () => {
          let cancellations = 0;
          let pulls = 0;
          // A timeout-shaped cleanup error must not reclassify the refusal or
          // expose its key-bearing message or certificate-verification cause.
          const cleanupError = Object.assign(new Error(`cleanup failed: ${KEY}`), {
            name: "TimeoutError",
            cause: { code: "CERT_HAS_EXPIRED" },
          });
          const stream = new ReadableStream<Uint8Array>(
            {
              pull() {
                pulls++;
                // Leave the body open: reading it would stall instead of refusing.
              },
              cancel() {
                cancellations++;
                if (disposal === "reject") {
                  return Promise.reject(cleanupError);
                }
              },
            },
            { highWaterMark: 0 },
          );
          if (disposal === "throw") {
            // An underlying source's throwing cancel hook becomes a rejected
            // promise; override the method to exercise an actual synchronous throw.
            stream.cancel = () => {
              cancellations++;
              throw cleanupError;
            };
          }
          const response = new Response(disposal === "null body" ? null : stream, {
            status,
            headers:
              refusal === "declared oversize" ? { "content-length": String(CAP + 1) } : undefined,
          });
          const { fetchImpl } = stubFetch({
            healthResponse: response,
            modelsResponse: response,
          });
          const result = await (endpoint === "health"
            ? health(BASE, fetchImpl)
            : models(BASE, KEY, fetchImpl)
          ).catch((err: unknown) => err);

          expect(result).toBeInstanceOf(RouterError);
          const error = result as RouterError;
          assertNoKeyFragment(String(error), KEY);
          assertNoKeyFragment(error.stack ?? "", KEY);
          expect(error.message).toBe(message);
          expect(error.status).toBe(refusal === "non-200" ? status : undefined);
          expect(error.timedOut).toBe(false);
          expect(error.tlsVerifyCode).toBeUndefined();
          expect(cancellations).toBe(disposal === "null body" ? 0 : 1);
          expect(pulls).toBe(0);
        });
      }
    }
  }
});

describe("scrub", () => {
  test("replaces anything after mar_live_ up to whitespace with an ellipsis", () => {
    expect(scrub(`Bearer ${KEY} went out`)).toBe("Bearer mar_live_… went out");
    expect(scrub(`two: ${KEY} and ${KEY}!`)).toBe("two: mar_live_… and mar_live_…");
    expect(scrub("no keys here")).toBe("no keys here");
  });

  test("stops at a closing parenthesis, so a key inside a longer token cannot eat it", () => {
    expect(scrub(`(${KEY})`)).toBe("(mar_live_…)");
    expect(scrub(`(X${KEY})`)).toBe("(Xmar_live_…)");
  });

  test("RouterError scrubs its own message at construction", () => {
    const err = new RouterError(`GET x failed with ${KEY} inside`);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("mar_live_…");
  });

  test("redacts to the canonical prefix, which the config's own key pattern agrees with", () => {
    // The redaction is derived from the one prefix constant, never a literal:
    // the shape that is issued and the shape that is redacted cannot drift.
    expect(scrub(KEY)).toBe(`${ROUTER_KEY_PREFIX}…`);
    // The config's key pattern accepts that same prefix, so a key it accepts
    // is a key scrub() redacts.
    expect(ROUTER_KEY_PATTERN.test(KEY)).toBe(true);
    const key = `${ROUTER_KEY_PREFIX}${"a".repeat(32)}`;
    expect(ROUTER_KEY_PATTERN.test(key)).toBe(true);
    expect(scrub(key)).toBe(`${ROUTER_KEY_PREFIX}…`);
    // The literal prefix is pinned deliberately: changing it is a deliberate
    // change, and the pins above then fail with it.
    expect(scrub(KEY)).toBe("mar_live_…");
    // And the redacted output carries no window of the key body.
    assertNoKeyFragment(scrub(KEY), KEY);
    assertNoKeyFragment(scrub(key), key);
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

  test("a class-shaped err.name that embeds the key scrubs to a balanced parenthetical", async () => {
    // "X" + the key passes the class-shape pattern, so the name really is
    // printed — scrub must reduce it without eating the ")" after it.
    const failure = new Error("fetch failed");
    failure.name = `X${KEY}`;
    const { fetchImpl } = stubFetch({ failWith: failure });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      const message = (err as RouterError).message;
      expect(message).toBe(`could not reach ${BASE}/healthz (Xmar_live_…)`);
      assertNoKeyFragment(message, KEY);
    }
  });
});
