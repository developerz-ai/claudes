import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The recording router stub for doctor's wiring proof: a real node:http server
 * on 127.0.0.1:0 that answers Claude Code's Messages API traffic and records,
 * for each request, only the SHA-256 of each credential it saw — never a
 * value. The recorded hashes are compared against the hash of the configured
 * key, so the proof "claude sent the router's key, and nothing else, to the
 * probe" never materialises the key in doctor's own output.
 */

export type CredentialHeader = "x-api-key" | "authorization" | "proxy-authorization" | "cookie";

export interface RecordedCredential {
  readonly header: CredentialHeader;
  readonly hash: string;
}

export interface RecordedRequest {
  readonly method: string;
  /** The path without the query string (claude sends `/v1/messages?beta=true`). */
  readonly pathname: string;
  readonly credentials: readonly RecordedCredential[];
  /** The `model` of a /v1/messages JSON body, when it parses and is a string. */
  readonly model: string | undefined;
}

export interface RouterStub {
  /** `http://127.0.0.1:<port>` — the base URL the probe's settings point at. */
  readonly baseUrl: string;
  requests(): readonly RecordedRequest[];
  close(): Promise<void>;
}

/** SHA-256 hex of a credential value; the only form a credential takes here. */
export function credentialHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 1 MiB is far more than a Messages API request body; larger is discarded. */
const MAX_BODY_BYTES = 2 ** 20;

/** Listens on 127.0.0.1:0 and resolves once the port is bound. */
export async function createRouterStub(): Promise<RouterStub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    handle(req, res, requests);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    await closeServer(server);
    throw new Error("the stub server has no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${bound.port}`,
    requests: () => requests,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  // Node keeps idle keep-alive sockets open, which would hang close(). Bun's
  // closeAllConnections() also stops the listener, so the close() after it is
  // a no-op that answers ERR_SERVER_NOT_RUNNING — closed is closed either way.
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      const code = (err as { readonly code?: string } | undefined)?.code;
      if (err !== undefined && code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * One request: record method, pathname, credential hashes and (for
 * /v1/messages) the model, then answer with the smallest reply Claude Code
 * accepts — SSE for a streaming request, plain JSON otherwise. These shapes
 * were verified live against Claude Code 2.1.300: a well-formed reply ends
 * the probe after exactly one POST.
 */
function handle(req: IncomingMessage, res: ServerResponse, requests: RecordedRequest[]): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let discarded = false;
  req.on("data", (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      discarded = true;
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => {
    res.destroy();
  });
  req.on("end", () => {
    const pathname = pathnameOf(req);
    const credentials = credentialsOf(req);
    const body = discarded ? "" : Buffer.concat(chunks).toString("utf8");
    const parsed = parseJson(body);
    const model = valueAsString(parsed?.model);
    requests.push({ method: req.method ?? "", pathname, credentials, model });
    if (req.method === "HEAD") {
      // Claude Code probes /api/hello at startup; any answer works.
      res.writeHead(404, { "content-type": "application/json" });
      res.end();
      return;
    }
    if (pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":1}');
      return;
    }
    if (pathname === "/v1/messages") {
      if (parsed?.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [event, data] of sseEvents(model ?? "stub")) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_doctor_stub",
          type: "message",
          role: "assistant",
          model: model ?? "stub",
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":{"type":"not_found"}}');
  });
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

/**
 * The credential hashes of one request: x-api-key and a Bearer authorization
 * are the shapes the configured key may legitimately travel in; anything else
 * credential-shaped — a proxy-authorization, a cookie, or an authorization
 * with any other scheme — is a FOREIGN credential by definition and recorded
 * the same way (hash only), so check 5's "no other credential arrived" proof
 * cannot go green while one slips past.
 */
function credentialsOf(req: IncomingMessage): RecordedCredential[] {
  const credentials: RecordedCredential[] = [];
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey !== "") {
    credentials.push({ header: "x-api-key", hash: credentialHash(xKey) });
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth !== "") {
    if (auth.startsWith("Bearer ")) {
      const bearer = auth.slice("Bearer ".length);
      if (bearer !== "") {
        credentials.push({ header: "authorization", hash: credentialHash(bearer) });
      }
    } else {
      credentials.push({ header: "authorization", hash: credentialHash(auth) });
    }
  }
  const proxyAuth = req.headers["proxy-authorization"];
  if (typeof proxyAuth === "string" && proxyAuth !== "") {
    credentials.push({ header: "proxy-authorization", hash: credentialHash(proxyAuth) });
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string" && cookie !== "") {
    credentials.push({ header: "cookie", hash: credentialHash(cookie) });
  }
  return credentials;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (text === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The smallest SSE stream Claude Code accepts for one assistant turn. */
function sseEvents(model: string): [string, unknown][] {
  return [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_doctor_stub",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}
