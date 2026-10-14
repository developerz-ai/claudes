import { describe, expect, test } from "bun:test";
import { type FetchLike, health, models, RouterError } from "./client";

const BASE = "https://router.example.test";
const KEY = "mar_live_TESTKEYabcdef0123456789";

interface Call {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

interface StubOptions {
  healthStatus?: number;
  healthBody?: string;
  modelsStatus?: number;
  modelsBody?: string;
  failWith?: Error;
}

function stubFetch(options: StubOptions = {}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, signal: init.signal });
    if (options.failWith !== undefined) {
      throw options.failWith;
    }
    if (url.endsWith("/healthz")) {
      return new Response(options.healthBody ?? JSON.stringify({ version: "1.4.2" }), {
        status: options.healthStatus ?? 200,
      });
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

  test("wraps network failures without leaking the key", async () => {
    const { fetchImpl } = stubFetch({ failWith: new Error("connection refused") });
    try {
      await health(BASE, fetchImpl);
      throw new Error("expected health to throw");
    } catch (err) {
      expect((err as RouterError).message).toContain("could not reach");
      expect((err as RouterError).message).not.toContain(KEY);
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
});
