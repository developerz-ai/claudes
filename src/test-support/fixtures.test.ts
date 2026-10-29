import { describe, expect, test } from "bun:test";
import { baseUrlSchema, keySchema } from "../config/schema";
import { KEY, ROUTER, type RouterResponseOptions, routerResponse } from "./fixtures";

describe("routerResponse", () => {
  const defaults = [
    { path: "/healthz", body: { version: "1.4.2" } },
    {
      path: "/v1/models",
      body: {
        data: [{ id: "claude-opus-4-1" }, { id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }],
      },
    },
  ];

  for (const { path, body } of defaults) {
    test(`${path}: fresh, independently readable defaults`, async () => {
      const first = routerResponse(`${ROUTER}${path}`);
      const second = routerResponse(`${ROUTER}${path}`, {
        healthBody: undefined,
        healthStatus: undefined,
        modelsBody: undefined,
        modelsStatus: undefined,
      });
      expect(first).not.toBe(second);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toEqual(body);
      expect(await second.json()).toEqual(body);
    });
  }

  for (const endpoint of ["health", "models"] as const) {
    const path = endpoint === "health" ? "/healthz" : "/v1/models";
    test(`${endpoint}: raw body and status overrides, including empty bodies`, async () => {
      for (const body of ["raw, not JSON", ""]) {
        const options: RouterResponseOptions = {
          healthBody: "other health",
          healthStatus: 502,
          modelsBody: "other models",
          modelsStatus: 403,
          [`${endpoint}Body`]: body,
          [`${endpoint}Status`]: 503,
        };
        const response = routerResponse(`${ROUTER}${path}`, options);
        expect(response.status).toBe(503);
        expect(await response.text()).toBe(body);
      }
    });

    test(`${endpoint}: exact Response takes precedence without reading or cloning`, async () => {
      let pulls = 0;
      let cancellations = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulls++;
          },
          cancel() {
            cancellations++;
          },
        },
        { highWaterMark: 0 },
      );
      const supplied = new Response(stream, { status: 401 });
      const options: RouterResponseOptions = {
        healthBody: "ignored",
        healthStatus: 0,
        modelsBody: "ignored",
        modelsStatus: 0,
        [`${endpoint}Response`]: supplied,
      };
      const response = routerResponse(`${ROUTER}${path}`, options);
      expect(response).toBe(supplied);
      expect(response.body).toBe(stream);
      expect(response.bodyUsed).toBe(false);
      expect(stream.locked).toBe(false);
      expect(pulls).toBe(0);
      await response.body?.cancel();
      expect(cancellations).toBe(1);
    });
  }

  test("health-only callers pin /healthz to version 1.4.2", async () => {
    const healthy = async (_url: string) => routerResponse(`${ROUTER}/healthz`);
    for (const url of [`${ROUTER}/v1/models`, `${ROUTER}/unknown`]) {
      const response = await healthy(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: "1.4.2" });
    }
  });

  test("unknown endpoint paths are refused even with Response overrides", () => {
    for (const path of ["/unknown", "/v1/model", "/prefix/healthz", "/healthz/"]) {
      expect(() =>
        routerResponse(`${ROUTER}${path}`, {
          healthResponse: new Response("health"),
          modelsResponse: new Response("models"),
        }),
      ).toThrow("unexpected router fixture endpoint");
    }
  });
});

describe("the shared fixture pair", () => {
  test("KEY satisfies the real key schema (mar_live_ plus exactly 32 chars)", () => {
    expect(keySchema.safeParse(KEY).success).toBe(true);
  });

  test("ROUTER satisfies the real baseUrl schema", () => {
    expect(baseUrlSchema.safeParse(ROUTER).success).toBe(true);
  });
});
