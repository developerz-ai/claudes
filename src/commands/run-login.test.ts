import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A non-TTY stdin that emits `chunks` verbatim, then `end`. */
function pipedBytes(...chunks: Buffer[]): StdinLike {
  const stdin = new EventEmitter();
  queueMicrotask(() => {
    for (const chunk of chunks) {
      stdin.emit("data", chunk);
    }
    stdin.emit("end");
  });
  return stdin as unknown as StdinLike;
}

/**
 * A TTY stdin: isTTY true, setRawMode recorded (and functional enough for the
 * real reader), delivering `input` once the listeners are attached.
 */
function ttyStdin(
  input: string | Buffer,
  event: "data" | "end" = "data",
): {
  stdin: StdinLike;
  rawModes: boolean[];
} {
  const rawModes: boolean[] = [];
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = (mode: boolean) => {
    rawModes.push(mode);
  };
  queueMicrotask(() => {
    if (event === "end") {
      stdin.emit("end");
    } else {
      stdin.emit("data", typeof input === "string" ? Buffer.from(input) : input);
    }
  });
  return { stdin: stdin as unknown as StdinLike, rawModes };
}

interface StubOptions {
  healthStatus?: number;
  modelsStatus?: number;
  failWith?: Error;
}

function stubFetch(options: StubOptions = {}): FetchLike {
  return async (url) => {
    if (options.failWith !== undefined) {
      throw options.failWith;
    }
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ version: "1.4.2" }), {
        status: options.healthStatus ?? 200,
      });
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
  /** The raw err-writer calls, in order — newline behaviour is the point. */
  errCalls: string[];
}

async function drive(argv: string[], stdin: StdinLike, fetch: FetchLike): Promise<Driven> {
  const out: string[] = [];
  const errCalls: string[] = [];
  const code = await runLogin(argv, {
    out: (text) => out.push(text),
    err: (text) => errCalls.push(text),
    env: { HOME: home },
    fetch,
    stdin,
  });
  return { code, out: out.join("\n"), err: errCalls.join(""), errCalls };
}

/** Every terminal write must be a whole line: the last one ends with "\n". */
function expectEndsWithNewline(driven: Driven): void {
  const last = driven.errCalls.at(-1);
  expect(last).toBeDefined();
  expect(last?.endsWith("\n")).toBe(true);
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

  test("TTY stdin: real hidden reader, prompt without a newline, exit 0", async () => {
    const { stdin, rawModes } = ttyStdin(`${KEY}\r`);
    const driven = await drive(["--url", ROUTER], stdin, stubFetch());
    expect(driven.code).toBe(0);
    expect(driven.out).toContain(`logged in to ${ROUTER} (router version 1.4.2)`);
    expect(driven.out).toContain("key mar_live_…");
    // The prompt itself stays newline-free; only the Enter echo adds one.
    expect(driven.errCalls).toEqual(["Router key: ", "\n"]);
    expect(rawModes).toEqual([true, false]);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
    expect(existsSync(configPath())).toBe(true);
  });

  test("TTY Ctrl-C at the prompt: exit 130, prompt plus newline on err, terminal restored", async () => {
    const { stdin, rawModes } = ttyStdin(Buffer.from([0x03]));
    const driven = await drive(["--url", ROUTER], stdin, stubFetch());
    expect(driven.code).toBe(130);
    // The prompt and the Ctrl-C newline only: exit 130 carries no message line.
    expect(driven.errCalls).toEqual(["Router key: ", "\n"]);
    expect(driven.out).toBe("");
    expect(rawModes).toEqual([true, false]);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
    expect(existsSync(configPath())).toBe(false);
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
    expectEndsWithNewline(driven);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
    expect(existsSync(configPath())).toBe(false);
  });

  test("5xx from the health check: exit 1, status named, newline-terminated", async () => {
    const driven = await drive(
      ["--url", ROUTER],
      pipedStdin(KEY),
      stubFetch({ healthStatus: 503 }),
    );
    expect(driven.code).toBe(1);
    expect(driven.err).toContain(`health check failed: GET ${ROUTER}/healthz failed: HTTP 503`);
    expect(driven.out).toBe("");
    expectEndsWithNewline(driven);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
    expect(existsSync(configPath())).toBe(false);
  });

  test("a failing config write: exit 1, could-not-save on err, newline-terminated", async () => {
    // A plain file where the config base should be: the store's mkdir cannot
    // succeed, whoever the caller is.
    writeFileSync(join(home, ".config"), "not a directory", "utf8");
    const driven = await drive(["--url", ROUTER], pipedStdin(KEY), stubFetch());
    expect(driven.code).toBe(1);
    expect(driven.err).toContain(`could not save the config to ${configPath()}`);
    expectEndsWithNewline(driven);
    expect(existsSync(configPath())).toBe(false);
  });

  test("stdin closing under the TTY prompt: exit 1, stdin closed, newline-terminated", async () => {
    const { stdin, rawModes } = ttyStdin("", "end");
    const driven = await drive(["--url", ROUTER], stdin, stubFetch());
    expect(driven.code).toBe(1);
    // The prompt was already written (newline-free) before the stream closed;
    // the closing message itself is a whole line.
    expect(driven.errCalls).toEqual(["Router key: ", "\n", "claudes login: stdin closed\n"]);
    expect(driven.out).toBe("");
    expect(rawModes).toEqual([true, false]);
    expect(existsSync(configPath())).toBe(false);
  });

  test("a 1 MiB unterminated line on stdin: exit 64, input too long, newline-terminated", async () => {
    const driven = await drive(
      ["--url", ROUTER],
      pipedBytes(Buffer.from("a".repeat(1024 * 1024))),
      stubFetch(),
    );
    expect(driven.code).toBe(64);
    expect(driven.err).toContain("claudes login: input too long for a router key");
    expectEndsWithNewline(driven);
    expect(driven.err).not.toContain("aaaa");
    expect(existsSync(configPath())).toBe(false);
  });

  test("an invalid --url: exit 64, invalid --url on err, newline-terminated", async () => {
    const driven = await drive(["--url", "definitely not a url"], pipedStdin(KEY), stubFetch());
    expect(driven.code).toBe(64);
    expect(driven.err).toContain("claudes login: invalid --url");
    expect(driven.err).not.toContain("did you mean");
    expectEndsWithNewline(driven);
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
    expectEndsWithNewline(driven);
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
      "claudes login: that is not a valid router key (expected the mar_live_… prefix followed by 32 characters)\n",
    );
    expect(existsSync(configPath())).toBe(false);
  });

  test("bad argv (a key on the command line): exit 64, refusal without the key", async () => {
    const driven = await drive(["--url", KEY], pipedStdin(KEY), stubFetch());
    expect(driven.code).toBe(64);
    expect(driven.err).toContain("looks like a router key");
    expect(driven.err).not.toContain(KEY);
    expectEndsWithNewline(driven);
    assertNoKeyFragment(`${driven.out}\n${driven.err}`, KEY);
  });

  test("the usage error (no --url) ends with a newline, usage and all", async () => {
    const driven = await drive([], pipedStdin(KEY), stubFetch());
    expect(driven.code).toBe(64);
    expect(driven.err).toContain("usage: claudes login --url");
    expectEndsWithNewline(driven);
    expect(driven.err).not.toContain(KEY);
  });
});
