import { describe, expect, test } from "bun:test";
import { ROUTER_KEY_PREFIX } from "../../config/schema";
import type { FetchLike } from "../../router/client";
import { assertNoKeyFragment } from "../../test-support/redact";
import { KEY, sampleConfig, TIERS } from "../harness";
import { checkRouter } from "./router";

const IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-4-1"];
/** The 32 secret characters after `mar_live_` — the part a leak must never carry. */
const KEY_BODY = KEY.slice(ROUTER_KEY_PREFIX.length);

/** One request the stub answered: its URL and the Authorization header sent. */
interface StubCall {
  readonly url: string;
  readonly authorization: string | undefined;
}

function stubFetch(
  options: { health?: () => Promise<Response>; models?: () => Promise<Response> } = {},
  calls: StubCall[] = [],
): FetchLike {
  return async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    if (url.endsWith("/healthz")) {
      return options.health
        ? await options.health()
        : new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    }
    if (options.models) {
      return await options.models();
    }
    return new Response(JSON.stringify({ data: IDS.map((id) => ({ id })) }), { status: 200 });
  };
}

/** A /healthz answer whose version string is the given text. */
function healthAnswer(version: string): () => Promise<Response> {
  return () => Promise.resolve(new Response(JSON.stringify({ version }), { status: 200 }));
}

describe("checkRouter", () => {
  test("a healthy router passes health, key and tiers, and yields the model ids", async () => {
    const calls: StubCall[] = [];
    const { results, modelIds } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({}, calls),
    });
    expect(modelIds).toEqual(IDS);
    expect(results.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(results[0]?.title).toContain("https://router.example.test");
    expect(results[0]?.title).toContain("1.4.2");
    // The healthy title's exact shape: a withheld version must not change it.
    expect(results[0]?.title).toBe("router https://router.example.test (version 1.4.2)");
    expect(results[1]?.title).toContain("4 models");
    expect(results[2]?.title).toContain("every pinned tier is served");
    // The stub saw the right requests: /healthz, then /v1/models with the key.
    expect(calls.map((c) => c.url)).toEqual([
      "https://router.example.test/healthz",
      "https://router.example.test/v1/models",
    ]);
    expect(calls[1]?.authorization).toBe(`Bearer ${KEY}`);
  });

  test("an unreachable router FAILs once, with no model ids", async () => {
    const dead: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const { results, modelIds } = await checkRouter({ config: sampleConfig(), fetch: dead });
    expect(modelIds).toBeUndefined();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.title).toContain("health check");
    expect(results[0]?.title).toContain("TypeError");
  });

  test("a rejected key FAILs with the re-login remedy", async () => {
    const { results } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({
        models: () => Promise.resolve(new Response("no", { status: 401 })),
      }),
    });
    expect(results[1]?.status).toBe("FAIL");
    expect(results[1]?.title).toContain("rejected the key (HTTP 401)");
    expect(results[1]?.fix).toContain("re-run `claudes login`");
  });

  test("an unhealthy /v1/models FAILs without leaking the key", async () => {
    const { results } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({
        models: () => Promise.resolve(new Response("boom", { status: 500 })),
      }),
    });
    expect(results[1]?.status).toBe("FAIL");
    expect(results[1]?.title).toContain("HTTP 500");
    assertNoKeyFragment(results[1]?.title ?? "", KEY);
  });

  test("a /healthz version echoing the configured key is withheld, and the router PASSes", async () => {
    const { results, modelIds } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({ health: healthAnswer(KEY) }),
    });
    expect(results[0]?.status).toBe("PASS");
    expect(results[0]?.title).toContain("withheld");
    expect(results[0]?.title).not.toContain("mar_live_");
    for (const result of results) {
      assertNoKeyFragment(result.title, KEY);
    }
    // The models verdict and the ids are untouched by the withheld version.
    expect(results[1]?.status).toBe("PASS");
    expect(results[1]?.title).toContain("4 models");
    expect(modelIds).toEqual(IDS);
  });

  test("a /healthz version carrying a bare key-body fragment is withheld", async () => {
    const { results, modelIds } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({ health: healthAnswer(KEY_BODY) }),
    });
    expect(results[0]?.status).toBe("PASS");
    expect(results[0]?.title).toContain("withheld");
    for (const result of results) {
      assertNoKeyFragment(result.title, KEY);
    }
    expect(results[1]?.status).toBe("PASS");
    expect(results[1]?.title).toContain("4 models");
    expect(modelIds).toEqual(IDS);
  });

  test("an error whose name carries the key body is withheld from the title", async () => {
    const hostile: FetchLike = async () => {
      const err = new Error("boom");
      err.name = KEY_BODY;
      throw err;
    };
    const { results } = await checkRouter({ config: sampleConfig(), fetch: hostile });
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.title).toContain("withheld");
    assertNoKeyFragment(results[0]?.title ?? "", KEY);
  });

  test("an unserved pinned tier WARNs with re-login", async () => {
    const served = IDS.filter((id) => id !== TIERS.sonnet);
    const { results, modelIds } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({
        models: () =>
          Promise.resolve(
            new Response(JSON.stringify({ data: served.map((id) => ({ id })) }), { status: 200 }),
          ),
      }),
    });
    expect(modelIds).toEqual(served);
    expect(results[2]?.status).toBe("WARN");
    expect(results[2]?.title).toContain(`sonnet=${TIERS.sonnet}`);
    expect(results[2]?.fix).toContain("re-run `claudes login`");
  });

  test("a RouterError's scrubbed message survives into the title", async () => {
    // A 503 answer makes the client itself raise the RouterError whose
    // scrubbed message the title must carry (rejecting inside fetch would only
    // exercise the client's unreachable-rewrap path).
    const { results } = await checkRouter({
      config: sampleConfig(),
      fetch: stubFetch({ health: () => Promise.resolve(new Response("no", { status: 503 })) }),
    });
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.title).toContain("HTTP 503");
  });
});
