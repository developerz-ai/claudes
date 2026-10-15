import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../../router/client";
import { sampleConfig, TIERS } from "../harness";
import { checkRouter } from "./router";

const IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-4-1"];

function stubFetch(
  options: { health?: () => Promise<Response>; models?: () => Promise<Response> } = {},
): FetchLike {
  return async (url) => {
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

describe("checkRouter", () => {
  test("a healthy router passes health, key and tiers, and yields the model ids", async () => {
    const { results, modelIds } = await checkRouter({ config: sampleConfig(), fetch: stubFetch() });
    expect(modelIds).toEqual(IDS);
    expect(results.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(results[0]?.title).toContain("https://router.example.test");
    expect(results[0]?.title).toContain("1.4.2");
    expect(results[1]?.title).toContain("4 models");
    expect(results[2]?.title).toContain("every pinned tier is served");
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
