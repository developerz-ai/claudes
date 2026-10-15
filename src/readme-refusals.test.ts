import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type DoctorDeps, runDoctor } from "./commands/doctor";
import { runKey } from "./commands/key";
import { MISSING_CONFIG_MESSAGE } from "./config/load";
import { ROUTER_UNREACHABLE_MESSAGE } from "./launch/preflight";
import { CLAUDE_NOT_FOUND_MESSAGE } from "./launch/run";
import { cleanup, deadFetch, type Harness, harness, KEY } from "./launch/run-harness";

/**
 * The README's "Refusals and exit codes" table quotes an exit code and a
 * message per scenario. Each test below is one row of that table, driving
 * the real launcher (or helper) through the run harness and asserting the
 * exit code and the exact stderr text. Where the source exports the message
 * as a constant the assertion uses it; the rest are inlined in their sources
 * (src/launch/argv.ts, the rerouting refusals in src/launch/run.ts, the TTY
 * refusal in src/commands/key.ts), so they are quoted literally here —
 * either way a drift between the README and the behaviour fails a row.
 */

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(() => {
  cleanup(h);
});

function errText(): string {
  return h.err.join("");
}

describe("README refusals and exit codes table", () => {
  test("row: passing --settings exits 64 with the quoted message", async () => {
    const code = await h.drive(["--settings", "/tmp/mine.json"], { fetch: deadFetch });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: --settings is not supported — claudes writes its own settings file to point claude at the router\n",
    );
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: passing --key exits 64 with the quoted message", async () => {
    const code = await h.drive(["--key", "x"], { fetch: deadFetch });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: --key is not supported — the router key comes from the config written by `claudes login`\n",
    );
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: a router-key-shaped argument exits 64 with the quoted message, before and after --", async () => {
    for (const args of [
      ["-p", KEY],
      ["--", KEY],
    ]) {
      const code = await h.drive(args, { fetch: deadFetch });
      expect(code).toBe(64);
      expect(errText()).toBe(
        "claudes: refusing an argument that looks like a router key — a key on the command line leaks into shell history and process listings\n",
      );
      h.err.length = 0;
    }
    // deadFetch would answer 69 were the probe reached: 64 proves it was not.
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: an env that would reroute the session exits 64, naming the variable", async () => {
    // The row covers an unknown CLAUDE_CODE_USE_* toggle and the two
    // host-managed names; the quoted message carries the variable's name.
    for (const name of [
      "CLAUDE_CODE_USE_CCR_V2",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    ]) {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, [name]: "1" },
        fetch: deadFetch,
      });
      expect(code).toBe(64);
      expect(errText()).toBe(
        `claudes: refusing: ${name} is set, so this session would not go to the router\n`,
      );
      h.err.length = 0;
    }
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: BUN_CONFIG_VERBOSE_FETCH set truthy exits 64 with the quoted message", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, BUN_CONFIG_VERBOSE_FETCH: "1" },
      fetch: deadFetch,
    });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed\n",
    );
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: `claudes key` at a terminal exits 64 with the quoted message", () => {
    const err: string[] = [];
    const writes: string[] = [];
    const code = runKey({
      env: { HOME: h.home },
      stdoutIsTTY: true,
      write: (text) => writes.push(text),
      stderr: (text) => err.push(text),
    });
    expect(code).toBe(64);
    expect(err.join("")).toBe("claudes key is for apiKeyHelper only\n");
    expect(writes).toEqual([]);
  });

  test("row: an unanswered pre-launch check exits 69 with the quoted message", async () => {
    const code = await h.drive(["-p", "hi"], { fetch: deadFetch });
    expect(code).toBe(69);
    // The default harness env sets no proxy and a plain fetch failure earns
    // no TLS or timeout note, so the unreachable message is the whole output.
    expect(errText()).toBe(`${ROUTER_UNREACHABLE_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: no config exits 78 with the quoted message", async () => {
    rmSync(h.home, { recursive: true, force: true });
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: claude missing from PATH exits 127 with the quoted message", async () => {
    const code = await h.drive(["-p", "hi"], { env: { HOME: h.home, PATH: "/nonexistent" } });
    expect(code).toBe(127);
    expect(errText()).toBe(`${CLAUDE_NOT_FOUND_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
  });

  test("row: doctor with at least one FAIL exits 1 and prints the FAIL lines", async () => {
    // A machine with no claude and no config: the runtime and config checks
    // FAIL on the injected fakes, so no process is spawned, no file is read
    // and no network is touched.
    const out: string[] = [];
    const err: string[] = [];
    const deps: DoctorDeps = {
      env: { HOME: "/nonexistent-home" },
      platform: "linux",
      nodeVersion: "22.0.0",
      cwd: "/nonexistent-cwd",
      nodePath: "/nonexistent-node",
      scriptPath: "/nonexistent-claudes",
      fetch: async () => {
        throw new Error("readme test: doctor must not touch the network");
      },
      postFetch: async () => {
        throw new Error("readme test: doctor must not touch the network");
      },
      runProc: async () => {
        throw new Error("readme test: doctor must not spawn processes");
      },
      resolveExecutable: () => undefined,
      load: () => ({ ok: false, exitCode: 78, message: MISSING_CONFIG_MESSAGE }),
      readFile: () => undefined,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    };
    const code = await runDoctor([], deps);
    expect(code).toBe(1);
    expect(out.join("")).toContain("[FAIL]");
  });
});
