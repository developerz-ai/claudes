import { describe, expect, test } from "bun:test";
import { assertNoKeyFragment } from "../test-support/redact";
import { KEY } from "./harness";
import { createRouterStub, credentialHash } from "./stub-server";

describe("createRouterStub", () => {
  test("listens on 127.0.0.1 with a kernel-chosen port and closes cleanly", async () => {
    const stub = await createRouterStub();
    expect(stub.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    await stub.close();
  });

  test("records credential HASHES for x-api-key and Bearer, never values", async () => {
    const stub = await createRouterStub();
    try {
      const res = await fetch(`${stub.baseUrl}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": KEY,
          authorization: `Bearer ${KEY}`,
        },
        body: JSON.stringify({
          model: "claude-sonnet-5-5",
          stream: false,
          max_tokens: 1,
          messages: [],
        }),
      });
      expect(res.status).toBe(200);
      const request = stub.requests().at(-1);
      expect(request?.method).toBe("POST");
      // The query string (?beta=true) must not defeat the pathname match.
      expect(request?.pathname).toBe("/v1/messages");
      expect(request?.model).toBe("claude-sonnet-5-5");
      expect(request?.credentials).toEqual([
        { header: "x-api-key", hash: credentialHash(KEY) },
        { header: "authorization", hash: credentialHash(KEY) },
      ]);
      // The recording holds hashes only: the key body appears nowhere in it.
      assertNoKeyFragment(JSON.stringify(stub.requests()), KEY);
    } finally {
      await stub.close();
    }
  });

  test("answers a streaming request with SSE and records the model", async () => {
    const stub = await createRouterStub();
    try {
      const res = await fetch(`${stub.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          stream: true,
          max_tokens: 1,
          messages: [],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: message_stop");
      expect(stub.requests().at(-1)?.model).toBe("claude-haiku-4-5");
    } finally {
      await stub.close();
    }
  });

  test("a request without credentials records none", async () => {
    const stub = await createRouterStub();
    try {
      const res = await fetch(`${stub.baseUrl}/api/hello`, { method: "HEAD" });
      expect(res.status).toBe(404);
      expect(stub.requests().at(-1)?.credentials).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  test("count_tokens answers and other paths 404", async () => {
    const stub = await createRouterStub();
    try {
      const counted = await fetch(`${stub.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(counted.status).toBe(200);
      const missing = await fetch(`${stub.baseUrl}/nope`, { method: "GET" });
      expect(missing.status).toBe(404);
      expect(stub.requests().length).toBe(2);
    } finally {
      await stub.close();
    }
  });
});
