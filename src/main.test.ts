import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_CONFIG_MESSAGE } from "./config/load";
import { credentialHash } from "./doctor/stub-server";
import { helpText } from "./help";
import { shellQuote } from "./launch/settings";
import { scrub } from "./router/errors";
import { KEY } from "./test-support/fixtures";
import { assertNoKeyFragment } from "./test-support/redact";
import { VERSION } from "./version";

/**
 * src/main.ts as a child process (`bun src/main.ts`): the only place the argv
 * slicing, the reserved-word routing and the exit codes are observable at
 * once. An in-process assertion would need main.ts to export an injectable
 * main() plus an "am I the entry point" guard, so the CLI is driven the way a
 * user drives it instead.
 */
const MAIN = join(import.meta.dir, "main.ts");
const SPAWN_TEST_TIMEOUT_MS = 30_000;
/** The drill spawns a CLI, a fake claude and a key helper: it needs its own budget. */
const DRILL_TIMEOUT_MS = 120_000;

let scratch: string;
let childEnv: Record<string, string>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claudes-main-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  // A closed env — never process.env wholesale — so an ambient
  // CLAUDE_CODE_USE_* (a remote Claude Code session exports one) or an ambient
  // ANTHROPIC_* cannot flip an answer, and the developer's own config is
  // never read. PATH holds an empty bin dir, so doctor finds no `claude`
  // there: its `claude --version` probe never runs and nothing reaches the
  // network.
  childEnv = {
    PATH: bin,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    TERM: "dumb",
  };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `bun src/main.ts <args>` with a closed stdin (nothing can block on a
 * read) and the closed env above.
 */
function runMain(args: readonly string[]): ChildRun {
  const res = spawnSync(process.execPath, [MAIN, ...args], {
    env: childEnv,
    cwd: scratch,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: SPAWN_TEST_TIMEOUT_MS,
  });
  if (res.error !== undefined) {
    throw res.error;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * The captured output must carry no router key. scrub() rewrites EVERY
 * occurrence of the prefix, bare ones included — its body may be empty — so a
 * rewritten message can hold no key at all (src/commands/login.ts names the
 * prefix in plain prose). The assertion proves only that the output never
 * mentions the prefix.
 */
function expectNoKeyMaterial(text: string): void {
  expect(scrub(text)).toBe(text);
}

describe("claudes main through a real process (bun src/main.ts)", () => {
  test("--version: VERSION on stdout, exit 0", () => {
    const res = runMain(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${VERSION}\n`);
    expect(res.stderr).toBe("");
    expectNoKeyMaterial(res.stdout);
  });

  test("-v: the same answer as --version", () => {
    const res = runMain(["-v"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${VERSION}\n`);
    expect(res.stderr).toBe("");
  });

  test("login: the argv.slice(1) handoff reaches the login parser", () => {
    const res = runMain(["login", "--bogus"]);
    expect(res.status).toBe(64);
    // parseLoginArgs numbers positions from 1 of the argv it was handed, so
    // "#1" is only possible when runLogin received exactly ["--bogus"]: a
    // missing slice would make the reserved word itself argument #1.
    expect(res.stderr).toContain("claudes login: unknown option #1");
    expect(res.stderr).not.toContain("unexpected argument");
    expect(res.stdout).toBe("");
    expectNoKeyMaterial(res.stderr);
  });

  const doctorKey = `mar_live_${"SyntheticDoctorKeyBody0123456789AB"}`;
  const rejectedDoctorArgs = [
    "--nonsense",
    "doctor-sensitive-sentinel-7d39",
    doctorKey,
    doctorKey.slice(9, 25),
    "--token=doctor-sensitive-sentinel-7d39",
    `--token=${doctorKey}`,
    "doctor-escape-\u001b[31m-sentinel",
    "doctor-osc-\u001b]0;sentinel\u0007",
    "doctor-return-\r-sentinel",
    "doctor-newline-\n-sentinel",
    "doctor-tab-\t-sentinel",
    "doctor-backspace-\b-sentinel",
    "doctor-delete-\u007f-sentinel",
  ];
  for (const prefix of [[], ["--live"]]) {
    for (const [index, value] of rejectedDoctorArgs.entries()) {
      test(`doctor handoff case ${index} reports position ${prefix.length + 1} without input`, () => {
        const res = runMain(["doctor", ...prefix, value]);
        expect(res.status).toBe(64);
        // Positions exclude the command word; #2 also proves --live was accepted.
        expect(res.stderr).toBe(
          `claudes doctor: unknown argument #${prefix.length + 1}\nusage: claudes doctor [--live]\n`,
        );
        expect(res.stdout).toBe("");
        expect(res.stderr).not.toContain(value);
        for (const byte of [7, 8, 9, 13, 27, 127]) {
          expect(res.stderr).not.toContain(String.fromCharCode(byte));
        }
        assertNoKeyFragment(res.stdout + res.stderr, doctorKey);
        expectNoKeyMaterial(res.stderr);
      });
    }
  }

  test("doctor with no config: exit 1 and a [FAIL] line", () => {
    const res = runMain(["doctor"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("[FAIL] config");
    expect(res.stdout).toContain(MISSING_CONFIG_MESSAGE);
    expectNoKeyMaterial(res.stdout);
    expectNoKeyMaterial(res.stderr);
  });

  test("--help: the help text on stdout, exit 0", () => {
    const res = runMain(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe(`${helpText("top")}\n`);
    expectNoKeyMaterial(res.stdout);
  });

  test("login --help: the login usage on stdout, exit 0", () => {
    const res = runMain(["login", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe(`${helpText("login")}\n`);
    expect(res.stdout).toContain("usage: claudes login --url <router-url>");
    expectNoKeyMaterial(res.stdout);
  });

  test("doctor --help: the doctor usage on stdout, exit 0", () => {
    const res = runMain(["doctor", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe(`${helpText("doctor")}\n`);
    expect(res.stdout).toContain("usage: claudes doctor [--live]");
    expectNoKeyMaterial(res.stdout);
  });

  test("key --help: the key command refuses the argument, exit 64", () => {
    // The key command takes no arguments, so --help is not a help request:
    // the README's refusals table promises this refusal.
    const res = runMain(["key", "--help"]);
    expect(res.status).toBe(64);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("claudes key: unknown argument #1\nusage: claudes key\n");
    expectNoKeyMaterial(res.stderr);
  });

  test("a non-reserved argument: the passthrough path, exit 78 without a config", () => {
    const res = runMain(["--verbose"]);
    expect(res.status).toBe(78);
    expect(res.stderr).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
    expect(res.stdout).toBe("");
    expectNoKeyMaterial(res.stderr);
  });
});

/**
 * The uninstall drill — the one flow no unit test can stand in for.
 *
 * Install, log in, run a session, uninstall, and check that nothing of the
 * user's own was touched. It runs here against a local router stack (a
 * node:http server on 127.0.0.1) and a fake `claude` on PATH, in a scratch
 * HOME, so the whole lifecycle is exercised for real: the CLI is a real child
 * process, the config is really written and really read, the key really
 * travels through the apiKeyHelper, and the uninstall really removes what it
 * claims to. The drill's checksum subject is Claude Code's own settings file
 * — the one thing a user must never lose to a launcher.
 *
 * What the drill cannot stand in for is the dev box: the published package
 * (`npm i -g @developerz.ai/claudes`, blocked on issue #7), the real Claude
 * Code binary and the team's router. That part stays a human drill — the
 * README's "The uninstall drill" section spells it out.
 */

/** One request the drill's router stack saw: the method, the path, the credential hashes. */
interface StackRequest {
  readonly method: string;
  readonly pathname: string;
  /** The SHA-256 of every credential the request carried — a hash, never a value. */
  readonly credentials: readonly string[];
}

/**
 * The local router stack: the endpoints claudes itself talks to — `/healthz`
 * for the pre-launch check and the login's health probe, `/v1/models` for the
 * login's tier resolution, `/v1/messages` for the session itself. It listens
 * on 127.0.0.1:0, so the drill never leaves the machine, and `/v1/models`
 * answers only to a request that carries a credential: the login has to prove
 * the key works, not merely reach the router.
 */
interface RouterStack {
  /** `http://127.0.0.1:<port>` — the router the drill logs in against. */
  readonly baseUrl: string;
  /** One entry per request. */
  requests(): readonly StackRequest[];
  close(): Promise<void>;
}

/** The model ids the stack advertises: one per tier family, each a parsable id. */
const STACK_MODEL_IDS = ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"];

async function startRouterStack(): Promise<RouterStack> {
  const requests: StackRequest[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {
      // The body is not read: the drill only cares about the headers.
    });
    req.on("end", () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const credentials: string[] = [];
      const apiKey = req.headers["x-api-key"];
      if (typeof apiKey === "string" && apiKey !== "") {
        credentials.push(credentialHash(apiKey));
      }
      const auth = req.headers.authorization;
      if (typeof auth === "string" && auth !== "") {
        credentials.push(credentialHash(auth.startsWith("Bearer ") ? auth.slice(7) : auth));
      }
      requests.push({ method: req.method ?? "", pathname, credentials });
      if (pathname === "/healthz") {
        answerJson(res, 200, { version: "1.4.2" });
        return;
      }
      if (pathname === "/v1/models") {
        if (credentials.length === 0) {
          answerJson(res, 401, { error: "no credential" });
          return;
        }
        answerJson(res, 200, { data: STACK_MODEL_IDS.map((id) => ({ id })) });
        return;
      }
      if (pathname === "/v1/messages") {
        answerJson(res, 200, {
          id: "msg_drill",
          type: "message",
          role: "assistant",
          model: "stub",
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        return;
      }
      answerJson(res, 404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the drill's router stack got no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    close: () => closeRouterStack(server),
  };
}

/** One JSON answer; the stack speaks the router's own dialect. */
function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Closes the stack: the keep-alive sockets first, then the listener. */
async function closeRouterStack(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * The fake `claude` the drill puts on PATH. It answers `--version` like the
 * real binary, and in a session it does what Claude Code does with the
 * generated settings: it applies the settings' own env, fetches the key
 * through the `apiKeyHelper` (never from the environment) and sends one
 * message to the router. It records what it saw — the key only as a hash, so
 * no key material reaches the record, the drill's output or the disk.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const record = {
  argv: process.argv.slice(2),
  envNames: Object.keys(process.env).sort(),
  settingsPath: null,
  settingsMode: null,
  baseUrl: null,
  model: null,
  keyHash: null,
  keyInArgvOrEnv: 0,
  routerStatus: null,
  failed: null,
};

function dump() {
  const out = process.env.FAKE_CLAUDE_OUT;
  if (out === undefined) return;
  fs.writeFileSync(out + ".tmp", JSON.stringify(record));
  fs.renameSync(out + ".tmp", out);
}

async function main() {
  // The plain-claude startup check: a version line, and nothing else.
  if (process.argv.includes("--version")) {
    process.stdout.write("2.1.300 (Claude Code)\\n");
    return;
  }
  const at = process.argv.indexOf("--settings");
  if (at === -1) return;
  const path = process.argv[at + 1];
  record.settingsPath = path;
  try {
    record.settingsMode = fs.statSync(path).mode & 0o777;
  } catch {
    record.settingsMode = null;
  }
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    settings = null;
  }
  if (settings === null || settings.env === undefined) return;
  // Claude Code applies the generated settings' own env to the session.
  for (const name of Object.keys(settings.env)) {
    process.env[name] = settings.env[name];
  }
  record.baseUrl = process.env.ANTHROPIC_BASE_URL ?? null;
  record.model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null;
  if (typeof settings.apiKeyHelper !== "string") return;
  // The key is fetched on demand, through the helper — never from the env.
  const key = execFileSync("/bin/sh", ["-c", settings.apiKeyHelper], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  record.keyHash = crypto.createHash("sha256").update(key, "utf8").digest("hex");
  for (const arg of process.argv) {
    if (arg.includes(key)) record.keyInArgvOrEnv += 1;
  }
  for (const value of Object.values(process.env)) {
    if (typeof value === "string" && value.includes(key)) record.keyInArgvOrEnv += 1;
  }
  const res = await fetch(String(record.baseUrl) + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      model: record.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  record.routerStatus = res.status;
  await res.text();
}

main().then(
  () => {
    dump();
    process.exit(0);
  },
  (err) => {
    record.failed = err === null || err === undefined ? "unknown" : String(err.name);
    dump();
    process.exit(1);
  },
);
`;

/** What the fake claude recorded: shapes and hashes, never a key. */
interface FakeRecord {
  readonly argv: readonly string[];
  readonly envNames: readonly string[];
  readonly settingsPath: string | null;
  readonly settingsMode: number | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly keyHash: string | null;
  readonly keyInArgvOrEnv: number;
  readonly routerStatus: number | null;
  readonly failed: string | null;
}

function readFakeRecord(path: string): FakeRecord {
  return JSON.parse(readFileSync(path, "utf8")) as FakeRecord;
}

/** The SHA-256 of a file's bytes: the drill's before/after checksum. */
function checksum(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The drill's child-process result: the exit code, the output, the spawn errno. */
interface DrillRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The spawn errno code — ENOENT when the command is not on PATH — if any. */
  readonly errorCode: string | undefined;
}

/**
 * The drill's own runner: a real child process, awaited rather than waited on
 * synchronously. A synchronous spawn would block this process's event loop,
 * and the router stack that has to answer the child lives in this process.
 */
async function runCli(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  input?: string,
): Promise<DrillRun> {
  const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin?.on("error", () => {
    // The child may exit before it reads stdin; the write then fails with
    // EPIPE, which is not the drill's business.
  });
  child.stdin?.end(input ?? "");
  const outcome = await new Promise<{ status: number | null; errorCode: string | undefined }>(
    (resolve) => {
      // "close", not "exit": the streams are drained by then, so a child's
      // last line is never read as a truncated one.
      child.on("close", (code) => resolve({ status: code, errorCode: undefined }));
      child.on("error", (err: NodeJS.ErrnoException) =>
        resolve({ status: null, errorCode: err.code }),
      );
    },
  );
  return { status: outcome.status, stdout, stderr, errorCode: outcome.errorCode };
}

describe("the uninstall drill", () => {
  let stack: RouterStack;
  let root: string;
  let home: string;
  let xdg: string;
  let binDir: string;
  let prefix: string;
  let prefixBin: string;
  let shim: string;
  let claudeSettings: string;
  let sessionRecord: string;
  let plainRecord: string;
  let drillEnv: Record<string, string>;

  beforeAll(async () => {
    stack = await startRouterStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claudes-drill-"));
    home = join(root, "home");
    xdg = join(root, "xdg");
    binDir = join(root, "bin");
    prefix = join(root, "prefix");
    prefixBin = join(prefix, "bin");
    shim = join(prefixBin, "claudes");
    claudeSettings = join(home, ".claude", "settings.json");
    sessionRecord = join(root, "session-record.json");
    plainRecord = join(root, "plain-record.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // Claude Code's own settings file: the drill's checksum subject. It
    // exists before the drill and must be byte-identical after it.
    writeFileSync(claudeSettings, '{"model":"opus"}\n', "utf8");
    writeFileSync(join(binDir, "claude"), FAKE_CLAUDE, "utf8");
    chmodSync(join(binDir, "claude"), 0o755);
    drillEnv = {
      // The fake claude first, then the installed claudes, then the real PATH
      // so the fake's own `#!/usr/bin/env node` still resolves.
      PATH: `${binDir}:${prefixBin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      TERM: "dumb",
      FAKE_CLAUDE_OUT: sessionRecord,
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const drill = async (): Promise<void> => {
    // --- install: a package tree in a global prefix, the way `npm i -g` lays
    // it out. The published package does not exist yet (issue #7), so the
    // drill installs the tree it can: the CLI itself, behind a bin shim.
    const packageDir = join(prefix, "lib", "node_modules", "@developerz.ai", "claudes");
    mkdirSync(packageDir, { recursive: true });
    cpSync(import.meta.dir, join(packageDir, "src"), { recursive: true });
    // The package's dependencies resolve from the checkout's own
    // node_modules: the drill installs the tree this repository has, since the
    // published one does not exist yet (issue #7).
    symlinkSync(
      join(import.meta.dir, "..", "node_modules"),
      join(packageDir, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@developerz.ai/claudes", version: VERSION }, null, 2)}\n`,
      "utf8",
    );
    mkdirSync(prefixBin, { recursive: true });
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(packageDir, "src", "main.ts"))} "$@"\n`,
      "utf8",
    );
    chmodSync(shim, 0o755);

    // The install result: the command is on PATH and answers.
    const installed = await runCli("claudes", ["--version"], drillEnv);
    expect(installed.status).toBe(0);
    expect(installed.stdout).toBe(`${VERSION}\n`);

    // --- login: the key comes from stdin, the router answers, the config lands.
    const login = await runCli("claudes", ["login", "--url", stack.baseUrl], drillEnv, `${KEY}\n`);
    expect(login.status).toBe(0);
    expect(login.stderr).toBe("");
    expect(login.stdout).toContain(`logged in to ${stack.baseUrl}`);
    expectNoKeyMaterial(login.stdout);
    assertNoKeyFragment(`${login.stdout}${login.stderr}`, KEY);

    const configDir = join(xdg, "claudes");
    const configFile = join(configDir, "config.json");
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(configFile, "utf8")) as {
      baseUrl: string;
      key: string;
      tiers: Record<string, string>;
    };
    expect(config.baseUrl).toBe(stack.baseUrl);
    expect(config.key).toBe(KEY);
    expect(config.tiers).toEqual({
      opus: "claude-opus-4-1",
      sonnet: "claude-sonnet-4-5",
      haiku: "claude-haiku-4-5",
    });

    // --- the session: the real launcher, the real settings file, the key
    // through the helper — and none of the user's own files touched.
    const before = checksum(claudeSettings);
    const session = await runCli("claudes", ["-p", "hello"], drillEnv);
    expect(session.status).toBe(0);
    expect(session.stderr).toBe("");

    const record = readFakeRecord(sessionRecord);
    expect(record.failed).toBeNull();
    expect(record.settingsPath?.startsWith(configDir)).toBe(true);
    expect(record.settingsMode).toBe(0o600);
    expect(record.baseUrl).toBe(stack.baseUrl);
    expect(record.model).toBe("claude-sonnet-4-5");
    // The key travelled through the helper, and the helper was the only way
    // it travelled: it is in no argv element and in no env value.
    expect(record.keyHash).toBe(credentialHash(KEY));
    expect(record.keyInArgvOrEnv).toBe(0);
    expect(record.routerStatus).toBe(200);
    // The router saw the session, carrying the configured key and nothing else.
    const messages = stack.requests().filter((request) => request.pathname === "/v1/messages");
    expect(messages.length).toBe(1);
    expect(messages[0]?.credentials).toEqual([credentialHash(KEY)]);
    // Claude Code's own settings file is byte-identical after the session.
    expect(checksum(claudeSettings)).toBe(before);

    // --- uninstall: the package tree and the config directory go, nothing else.
    rmSync(prefix, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(configDir)).toBe(false);
    const gone = await runCli("claudes", ["--version"], drillEnv);
    expect(gone.status).toBeNull();
    expect(gone.errorCode).toBe("ENOENT");
    // The checksum is still the one from before the drill.
    expect(checksum(claudeSettings)).toBe(before);

    // --- plain claude still starts after the uninstall.
    const plain = await runCli(join(binDir, "claude"), ["--version"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      TERM: "dumb",
      FAKE_CLAUDE_OUT: plainRecord,
    });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("2.1.300");
    const plainSeen = readFakeRecord(plainRecord);
    expect(plainSeen.argv).toEqual(["--version"]);
    expect(plainSeen.settingsPath).toBeNull();
    expect(plainSeen.envNames.filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
  };

  test(
    "install, login, a session, an uninstall — and ~/.claude is never touched",
    drill,
    DRILL_TIMEOUT_MS,
  );

  test("the checksum the drill compares is sensitive to a one-byte change", () => {
    // The guard is only worth what its comparison can see: a checksum that
    // ignored a changed byte would make the drill's central assertion vacuous.
    const same = join(root, "same");
    const other = join(root, "other");
    writeFileSync(same, "claude", "utf8");
    writeFileSync(other, "claudE", "utf8");
    expect(checksum(same)).toBe(checksum(same));
    expect(checksum(same)).not.toBe(checksum(other));
  });
});
