import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, configFile } from "../config/paths";
import type { FetchLike } from "../router/client";
import { assertNoKeyFragment } from "../test-support/redact";
import { runLogin } from "./login";
import type { StdinLike } from "./login-input";

const ROUTER = "https://router.example.test";
const KEY = "mar_live_FAKEKEYabcdef0123456789abcdefghi";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-runlogin-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * A non-TTY stdin that delivers `line` (plus a newline) once the reader has
 * attached — the microtask runs only after login's synchronous prologue has
 * registered the stream listeners.
 */
function pipedStdin(line: string): StdinLike {
  const stdin = new EventEmitter();
  queueMicrotask(() => {
    stdin.emit("data", Buffer.from(`${line}\n`));
    stdin.emit("end");
  });
  return stdin as unknown as StdinLike;
}

interface StubOptions {
  modelsStatus?: number;
  failWith?: Error;
}

function stubFetch(options: StubOptions = {}): FetchLike {
  return async (url) => {
    if (options.failWith !== undefined) {
      throw options.failWith;
    }
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        data: [{ id: "claude-opus-4-1" }, { id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }],
      }),
      { status: options.modelsStatus ?? 200 },
    );
  };
}

interface Driven {
  code: number;
  out: string;
  err: string;
}

async function drive(argv: string[], stdin: StdinLike, fetch: FetchLike): Promise<Driven> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runLogin(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    env: { HOME: home },
    fetch,
    stdin,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function configPath(): string {
  return configFile(configDir({ HOME: home }));
}

describe("runLogin (real wiring, injected writers)", () => {
  test("success: exit 0, report on out, key redacted, config written", async () => {
    const driven = await drive(["--url", ROUTER], pipedStdin(KEY), stubFetch());
    expect(driven.code).toBe(0);
    expect(driven.out).toContain(`logged in to ${ROUTER} (router version 1.4.2)`);
    expect(driven.out).toContain("key mar_live_…");
    expect(driven.out).toContain(`config saved to ${configPath()}`);
    expect(driven.err).toBe("");
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
    expect(existsSync(configPath())).toBe(true);
  });

  test("401 from the router: exit 1, the rejection line on err", async () => {
    const driven = await drive(
      ["--url", ROUTER],
      pipedStdin(KEY),
      stubFetch({ modelsStatus: 401 }),
    );
    expect(driven.code).toBe(1);
    expect(driven.err).toContain("claudes login: router rejected the key (HTTP 401)");
    expect(driven.out).toBe("");
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
    expect(existsSync(configPath())).toBe(false);
  });

  test("a fetch error quoting the key: exit 1, scrubbed to key-free text", async () => {
    const driven = await drive(
      ["--url", ROUTER],
      pipedStdin(KEY),
      stubFetch({ failWith: new TypeError(`Headers.append: "Bearer ${KEY}" is invalid`) }),
    );
    expect(driven.code).toBe(1);
    expect(driven.err).toContain("could not reach");
    expect(driven.err).not.toContain(KEY);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
  });

  test("a malformed key: exit 64, the pinned fixed-sentence refusal on err", async () => {
    const driven = await drive(
      ["--url", ROUTER],
      pipedStdin(`mar_live_${"A".repeat(31)}`),
      stubFetch(),
    );
    expect(driven.code).toBe(64);
    expect(driven.err).toBe(
      "claudes login: that is not a valid router key (expected the mar_live_… prefix followed by 32 characters)",
    );
    expect(existsSync(configPath())).toBe(false);
  });

  test("bad argv (a key on the command line): exit 64, refusal without the key", async () => {
    const driven = await drive(["--url", KEY], pipedStdin(KEY), stubFetch());
    expect(driven.code).toBe(64);
    expect(driven.err).toContain("looks like a router key");
    expect(driven.err).not.toContain(KEY);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
  });
});
