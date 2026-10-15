import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsFile } from "../config/paths";
import { CLAUDE_NOT_FOUND_MESSAGE, FORWARDED_SIGNALS, resolveExecutable } from "./run";
import { cleanup, fakeWiring, type Harness, harness } from "./run-harness";

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

describe("run: claude resolution and exit codes", () => {
  test("claude not on PATH: exit 127, the message, no spawn", async () => {
    const code = await h.drive(["-p", "hi"], { env: { HOME: h.home, PATH: "/nonexistent" } });
    expect(code).toBe(127);
    expect(errText()).toBe(`${CLAUDE_NOT_FOUND_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
  });

  test("the child's exit code passes through", async () => {
    for (const expected of [0, 1, 7, 64]) {
      const code = await h.drive(["-p", "hi"], {
        spawnScript: (child) => child.emit("exit", expected, null),
      });
      expect(code).toBe(expected);
    }
  });

  test("a child killed by a signal exits 128+n", async () => {
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", null, "SIGKILL"),
    });
    expect(code).toBe(137);
  });

  test("a spawn error is reported and exits 127", async () => {
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("error", new Error("ENOENT")),
    });
    expect(code).toBe(127);
    expect(errText()).toContain("could not run");
  });

  test("spawns with --settings first, the user args after, and the stripped env", async () => {
    const code = await h.drive(["--model", "claude-opus", "-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.spawnCalls[0]?.command).toBe(join(h.binDir, "claude"));
    expect(h.spawnCalls[0]?.argv).toEqual([
      "--settings",
      settingsFile(h.dir, process.pid),
      "--model",
      "opus",
      "-p",
      "hi",
    ]);
    const env = h.spawnCalls[0]?.env;
    expect(env).toBeDefined();
    expect("ANTHROPIC_AUTH_TOKEN" in (env ?? {})).toBe(false);
    expect(env?.PATH).toBe(h.binDir);
  });
});

describe("run: signal forwarding", () => {
  test("SIGINT, SIGTERM and SIGHUP are forwarded to the child, then unwired", async () => {
    const { wiring, fired } = fakeWiring();
    const code = await h.drive(["-p", "hi"], {
      wiring,
      spawnScript: (child) => {
        // Forward every signal, then let the child die of the last one.
        queueMicrotask(() => {
          for (const signal of FORWARDED_SIGNALS) {
            fired.get(signal)?.();
          }
          child.emit("exit", null, "SIGTERM");
        });
      },
    });
    expect(code).toBe(143);
    expect(h.children[0]?.kills).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(fired.size).toBe(0);
  });

  test("stdin a TTY: SIGINT is wired as a no-op that never reaches the child", async () => {
    const { wiring, fired } = fakeWiring();
    let sigintWiredWhileRunning = false;
    const code = await h.drive(["-p", "hi"], {
      wiring,
      stdinIsTTY: true,
      spawnScript: (child) => {
        queueMicrotask(() => {
          // While the child runs, a SIGINT listener IS registered — without one
          // Node's default disposition would kill claudes mid-shutdown.
          sigintWiredWhileRunning = fired.has("SIGINT");
          for (const signal of FORWARDED_SIGNALS) {
            fired.get(signal)?.(); // the no-op fires: only two kills land
          }
          child.emit("exit", null, "SIGHUP");
        });
      },
    });
    expect(sigintWiredWhileRunning).toBe(true);
    expect(code).toBe(129);
    expect(h.children[0]?.kills).toEqual(["SIGTERM", "SIGHUP"]);
    expect(fired.size).toBe(0); // the no-op unwires with the rest
  });

  test("stdin not a TTY (the default): SIGINT is forwarded", async () => {
    const { wiring, fired } = fakeWiring();
    const code = await h.drive(["-p", "hi"], {
      wiring,
      stdinIsTTY: false,
      spawnScript: (child) => {
        queueMicrotask(() => {
          fired.get("SIGINT")?.();
          child.emit("exit", null, "SIGINT");
        });
      },
    });
    expect(code).toBe(130);
    expect(h.children[0]?.kills).toEqual(["SIGINT"]);
  });

  test("a signal arriving after the child exited changes nothing", async () => {
    const { wiring, fired } = fakeWiring();
    const code = await h.drive(["-p", "hi"], {
      wiring,
      spawnScript: (child) => {
        queueMicrotask(() => {
          child.emit("exit", 3, null);
          fired.get("SIGINT")?.();
        });
      },
    });
    expect(code).toBe(3);
  });
});

describe("resolveExecutable", () => {
  test("walks the PATH in order and returns the first executable hit", () => {
    const first = mkdtempSync(join(tmpdir(), "claudes-resolve-"));
    const second = mkdtempSync(join(tmpdir(), "claudes-resolve-"));
    try {
      const here = join(first, "claude");
      writeFileSync(here, "#!/bin/sh\n", "utf8");
      chmodSync(here, 0o755);
      const there = join(second, "claude");
      writeFileSync(there, "#!/bin/sh\n", "utf8");
      chmodSync(there, 0o755);
      expect(resolveExecutable("claude", { PATH: `${first}:${second}` })).toBe(here);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("skips non-executable and missing candidates", () => {
    expect(resolveExecutable("claude", { PATH: "/nonexistent" })).toBeUndefined();
    expect(resolveExecutable("claude", {})).toBeUndefined();
  });

  test("a directory named claude never wins the lookup", () => {
    const withDir = mkdtempSync(join(tmpdir(), "claudes-resolve-"));
    const withFile = mkdtempSync(join(tmpdir(), "claudes-resolve-"));
    try {
      // A directory carries the executable bit too; only a regular file counts.
      mkdirSync(join(withDir, "claude"), { recursive: true });
      expect(resolveExecutable("claude", { PATH: withDir })).toBeUndefined();
      const file = join(withFile, "claude");
      writeFileSync(file, "#!/bin/sh\n", "utf8");
      chmodSync(file, 0o755);
      expect(resolveExecutable("claude", { PATH: `${withDir}:${withFile}` })).toBe(file);
    } finally {
      rmSync(withDir, { recursive: true, force: true });
      rmSync(withFile, { recursive: true, force: true });
    }
  });
});
