import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FetchLike, TLS_VERIFY_CODES } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import {
  PREFLIGHT_TIMEOUT_NOTE_MESSAGE,
  PROXY_NOTE_MESSAGE,
  preflightTimeoutMs,
  ROUTER_UNREACHABLE_MESSAGE,
  TLS_EXPIRED_NOTE_MESSAGE,
  TLS_HOSTNAME_NOTE_MESSAGE,
  TLS_NOT_YET_VALID_NOTE_MESSAGE,
  TLS_VERIFY_NOTE_MESSAGE,
} from "./preflight";
import { cleanup, deadFetch, type Harness, harness, KEY } from "./run-harness";

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

describe("run: router pre-flight", () => {
  test("an unreachable router: exit 69, the exact message, no spawn", async () => {
    const code = await h.drive(["-p", "hi"], { fetch: deadFetch });
    expect(code).toBe(69);
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
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

  test("a proxy set and a double timeout: both notes, proxy note first", async () => {
    const alwaysTimeout: FetchLike = async () => {
      const err = new Error("the probe timed out");
      err.name = "TimeoutError";
      throw err;
    };
    expect(
      await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, HTTPS_PROXY: "http://proxy.corp.test:3128" },
        fetch: alwaysTimeout,
      }),
    ).toBe(69);
    expect(errText()).toBe(
      `${ROUTER_UNREACHABLE_MESSAGE}\n${PROXY_NOTE_MESSAGE}\n${PREFLIGHT_TIMEOUT_NOTE_MESSAGE}\n`,
    );
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

  // NODE_USE_ENV_PROXY honours the four HTTP(S) names only: a scheme-agnostic
  // ALL_PROXY alone does not explain a failed probe, so it earns no note.
  for (const proxy of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const) {
    test(`${proxy} set without NODE_USE_ENV_PROXY: the proxy note follows the message`, async () => {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, [proxy]: "http://proxy.corp.test:3128" },
        fetch: deadFetch,
      });
      expect(code).toBe(69);
      expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n${PROXY_NOTE_MESSAGE}\n`);
    });
  }

  for (const proxy of ["ALL_PROXY", "all_proxy"] as const) {
    test(`${proxy} set alone: no proxy note (NODE_USE_ENV_PROXY ignores it)`, async () => {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, [proxy]: "socks5://proxy.corp.test:1080" },
        fetch: deadFetch,
      });
      expect(code).toBe(69);
      expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
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

  // The errno codes Node puts on err.cause.code when certificate verification
  // itself failed; each one earns its own note next to the unreachable
  // message — the four trust errnos the CA hint; an expired, a not-yet-valid
  // certificate and a host-name mismatch their own words (no CA store fixes
  // any of them).
  const TLS_NOTES: Readonly<Record<string, string>> = {
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: TLS_VERIFY_NOTE_MESSAGE,
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: TLS_VERIFY_NOTE_MESSAGE,
    SELF_SIGNED_CERT_IN_CHAIN: TLS_VERIFY_NOTE_MESSAGE,
    DEPTH_ZERO_SELF_SIGNED_CERT: TLS_VERIFY_NOTE_MESSAGE,
    CERT_HAS_EXPIRED: TLS_EXPIRED_NOTE_MESSAGE,
    CERT_NOT_YET_VALID: TLS_NOT_YET_VALID_NOTE_MESSAGE,
    ERR_TLS_CERT_ALTNAME_INVALID: TLS_HOSTNAME_NOTE_MESSAGE,
  };
  test("the note table covers exactly the client's TLS verification errnos", () => {
    expect(Object.keys(TLS_NOTES).sort()).toEqual([...TLS_VERIFY_CODES].sort());
  });
  for (const [code, note] of Object.entries(TLS_NOTES)) {
    test(`a TLS verification failure (${code}): exit 69, message kept, its note appended`, async () => {
      const tlsFetch: FetchLike = async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(`raw tls text for ${code} — quotes 'stuff'`), { code }),
        });
      };
      expect(await h.drive(["-p", "hi"], { fetch: tlsFetch })).toBe(69);
      expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n${note}\n`);
      // The note is keyed off the errno only: no raw TLS text is quoted.
      expect(errText()).not.toContain("raw tls text");
      assertNoKeyFragment(errText(), KEY);
    });
  }

  test("a TLS note and a proxy set: both notes, proxy note first", async () => {
    const tlsFetch: FetchLike = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("self signed certificate in certificate chain"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        }),
      });
    };
    expect(
      await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, HTTPS_PROXY: "http://proxy.corp.test:3128" },
        fetch: tlsFetch,
      }),
    ).toBe(69);
    expect(errText()).toBe(
      `${ROUTER_UNREACHABLE_MESSAGE}\n${PROXY_NOTE_MESSAGE}\n${TLS_VERIFY_NOTE_MESSAGE}\n`,
    );
  });

  test("a non-TLS connection error: no CA note", async () => {
    const refused: FetchLike = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
          code: "ECONNREFUSED",
        }),
      });
    };
    expect(await h.drive(["-p", "hi"], { fetch: refused })).toBe(69);
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
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
