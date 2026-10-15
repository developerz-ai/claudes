import { describe, expect, test } from "bun:test";
import { sampleConfig, TIERS } from "../harness";
import { checkLive, type PostFetch } from "./live";

interface Posted {
  readonly url: string;
  readonly init: { method: string; headers: Record<string, string>; body: string };
}

function stubPost(respond: () => Response): { fetch: PostFetch; posted: Posted[] } {
  const posted: Posted[] = [];
  const fetch: PostFetch = async (url, init) => {
    posted.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
    return respond();
  };
  return { fetch, posted };
}

describe("checkLive", () => {
  test("one POST, max_tokens 1, on the haiku tier; reports only status and request id", async () => {
    const { fetch, posted } = stubPost(
      () => new Response("{}", { status: 200, headers: { "x-request-id": "req-abc-123" } }),
    );
    const result = await checkLive({ config: sampleConfig(), fetch });
    expect(result.status).toBe("PASS");
    expect(result.title).toContain("HTTP 200");
    expect(result.title).toContain("request id req-abc-123");
    expect(posted).toHaveLength(1);
    const call = posted[0] as Posted;
    expect(call.url).toBe("https://router.example.test/v1/messages");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.authorization).toBe(`Bearer ${sampleConfig().key}`);
    const body = JSON.parse(call.init.body) as { model: string; max_tokens: number };
    expect(body.model).toBe(TIERS.haiku);
    expect(body.max_tokens).toBe(1);
  });

  test("also finds the request-id spelling", async () => {
    const { fetch } = stubPost(
      () => new Response("{}", { status: 200, headers: { "request-id": "req-xyz" } }),
    );
    const result = await checkLive({ config: sampleConfig(), fetch });
    expect(result.title).toContain("request id req-xyz");
  });

  test("a non-200 FAILs with the status and the id when present", async () => {
    const { fetch } = stubPost(
      () => new Response("no", { status: 503, headers: { "x-request-id": "req-503" } }),
    );
    const result = await checkLive({ config: sampleConfig(), fetch });
    expect(result.status).toBe("FAIL");
    expect(result.title).toContain("HTTP 503");
    expect(result.title).toContain("req-503");
  });

  test("an unreachable router FAILs by error name, never by message", async () => {
    const fetch: PostFetch = async () => {
      throw new TypeError(`fetch failed: Bearer ${sampleConfig().key} is invalid`);
    };
    const result = await checkLive({ config: sampleConfig(), fetch });
    expect(result.status).toBe("FAIL");
    expect(result.title).toContain("TypeError");
    expect(result.title).not.toContain(sampleConfig().key);
  });

  test("a timeout FAILs with the seconds named", async () => {
    const fetch: PostFetch = async () => {
      const err = new Error("too slow");
      err.name = "TimeoutError";
      throw err;
    };
    const result = await checkLive({ config: sampleConfig(), fetch, timeoutMs: 10_000 });
    expect(result.status).toBe("FAIL");
    expect(result.title).toContain("timed out after 10 s");
  });

  test("a request id with a hostile shape is not printed", async () => {
    // A newline in a header value is refused at Response construction, so the
    // hostile shape here is a legal header that fails the id pattern: spaces,
    // and the key itself, which must not survive anywhere.
    const { fetch } = stubPost(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "x-request-id": `Bearer ${sampleConfig().key} id` },
        }),
    );
    const result = await checkLive({ config: sampleConfig(), fetch });
    expect(result.title).toContain("no request id header");
    expect(result.title).not.toContain(sampleConfig().key);
  });
});
