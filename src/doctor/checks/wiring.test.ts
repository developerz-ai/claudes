import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as httpCreateServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configDir } from "../../config/paths";
import { buildArgv } from "../../launch/argv";
import { assertNoKeyFragment } from "../../test-support/redact";
import { FOREIGN_CREDENTIAL, fakeClaudeProc, KEY, sampleConfig, TIERS } from "../harness";
import { createRouterStub, credentialHash, type RouterStub } from "../stub-server";
import {
  checkWiring,
  PROBE_SIGNALS,
  type ProbeSignal,
  type ProbeSignalWiring,
  WIRING_ARGS,
} from "./wiring";

const CLAUDE = "/usr/local/bin/claude";
const NODE = "/usr/local/bin/node";
const SCRIPT = "/opt/claudes/bin/claudes.js";

/** A pid no process can have: the probe tree named after it is stale. */
const DEAD_PID = 999_999_999;

interface Scratch {
  /** The injected HOME; the config directory lives under it. */
  readonly home: string;
  /** The config directory the probe's tree is created in. */
  readonly dir: string;
}

/** A temp HOME whose config directory the probe can create its tree in. */
function scratch(): Scratch {
  const home = mkdtempSync(join(tmpdir(), "wiring-test-"));
  return { home, dir: configDir({ HOME: home }) };
}

function cleanup(s: Scratch): void {
  rmSync(s.home, { recursive: true, force: true });
}

/** The seams a test may override; the rest of the deps are fixed here. */
type Overrides = Partial<
  Pick<
    Parameters<typeof checkWiring>[0],
    "probeDir" | "rm" | "signals" | "createStub" | "timeoutMs"
  >
>;

function deps(
  s: Scratch,
  runProc: Parameters<typeof checkWiring>[0]["runProc"],
  overrides: Overrides = {},
): Parameters<typeof checkWiring>[0] {
  return {
    env: { HOME: s.home, PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "sk-ant-personal" },
    nodePath: NODE,
    scriptPath: SCRIPT,
    claudePath: CLAUDE,
    runProc,
    rm: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    ...overrides,
  };
}

/** A signal seam: the handlers are captured, never wired to the real process. */
function trapSignals(): {
  readonly wiring: ProbeSignalWiring;
  readonly fired: Map<ProbeSignal, () => void>;
  readonly raised: ProbeSignal[];
} {
  const fired = new Map<ProbeSignal, () => void>();
  const raised: ProbeSignal[] = [];
  return {
    fired,
    raised,
    wiring: {
      on: (signal, handler) => fired.set(signal, handler),
      off: (signal, handler) => {
        if (fired.get(signal) === handler) {
          fired.delete(signal);
        }
      },
      raise: (signal) => {
        raised.push(signal);
      },
    },
  };
}

describe("checkWiring", () => {
  test("passes when the stub sees the configured key's hash, a tier model, and nothing else", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("PASS");
      expect(result.title).toContain("model claude-sonnet-5-5");
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
      // The probe's claude argv is the launcher's own: --settings first, then
      // the ping turn and the isolation flags.
      const argv = fake.calls[0]?.argv ?? [];
      expect(argv[0]).toBe("--settings");
      expect(argv.slice(2)).toEqual([...WIRING_ARGS]);
      // The child env is the launcher's stripped env, redirected to the probe's
      // throwaway HOME/XDG so `claudes key` cooperates with the stub's URL.
      const env = fake.calls[0]?.env ?? {};
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      const probeRoot = dirname(env.XDG_CONFIG_HOME as string);
      expect(env.HOME).toBe(join(probeRoot, "home"));
      expect(env.XDG_CONFIG_HOME).toBe(join(probeRoot, "xdg"));
      // The probe's tree is created under the config directory — not in the OS
      // temp directory — and it is gone once the check returns.
      expect(dirname(probeRoot)).toBe(s.dir);
      expect(basename(probeRoot)).toMatch(/^probe\.\d+$/);
      expect(existsSync(probeRoot)).toBe(false);
    } finally {
      cleanup(s);
    }
  });

  test("writes a 0600 settings file in a 0700 dir, built by the launcher's builders", async () => {
    const s = scratch();
    let seen: { path: string; text: string; fileMode: number; dirMode: number } | undefined;
    const capturing = fakeClaudeProc();
    const runProc = async (...args: Parameters<typeof capturing.runProc>) => {
      const call = { command: args[0], argv: args[1], env: args[2].env ?? {} };
      const settingsAt = call.argv.indexOf("--settings");
      const path = call.argv[settingsAt + 1] as string;
      // Capture the facts during the run: the check removes its tree before
      // returning, so nothing is left to stat afterwards.
      seen = {
        path,
        text: readFileSync(path, "utf8"),
        fileMode: statSync(path).mode & 0o777,
        dirMode: statSync(join(path, "..")).mode & 0o777,
      };
      return await capturing.runProc(...args);
    };
    try {
      const result = await checkWiring(deps(s, runProc), sampleConfig());
      expect(result.status).toBe("PASS");
      const facts = seen as { path: string; text: string; fileMode: number; dirMode: number };
      expect(facts.fileMode).toBe(0o600);
      expect(facts.dirMode).toBe(0o700);
      const settings = JSON.parse(facts.text) as {
        readonly apiKeyHelper: string;
        readonly env: Record<string, string>;
      };
      // The launcher's key helper, verbatim.
      expect(settings.apiKeyHelper).toBe(`'${NODE}' '${SCRIPT}' key`);
      // The base URL points at the stub, and the key never enters the file.
      expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(TIERS.sonnet);
      assertNoKeyFragment(facts.text, KEY);
    } finally {
      cleanup(s);
    }
  });

  test("the key's only disk copy is 0600 in 0700 dirs, and lives only while the child runs", async () => {
    const s = scratch();
    const capturing = fakeClaudeProc();
    const removed: string[] = [];
    let copy: { path: string; fileMode: number; dirModes: number[] } | undefined;
    const runProc = async (...args: Parameters<typeof capturing.runProc>) => {
      const env = args[2].env ?? {};
      const path = join(env.XDG_CONFIG_HOME as string, "claudes", "config.json");
      // Capture during the run: the copy is deleted the moment the child exits.
      copy = {
        path,
        fileMode: statSync(path).mode & 0o777,
        dirModes: [
          statSync(join(path, "..")).mode & 0o777,
          statSync(join(path, "..", "..")).mode & 0o777,
          statSync(join(path, "..", "..", "..")).mode & 0o777,
        ],
      };
      return await capturing.runProc(...args);
    };
    try {
      const result = await checkWiring(
        deps(s, runProc, {
          rm: (path) => {
            removed.push(path);
            rmSync(path, { recursive: true, force: true });
          },
        }),
        sampleConfig(),
      );
      expect(result.status).toBe("PASS");
      const facts = copy as { path: string; fileMode: number; dirModes: number[] };
      expect(facts.fileMode).toBe(0o600);
      expect(facts.dirModes).toEqual([0o700, 0o700, 0o700]);
      // The copy goes first — the moment the child is gone — and the tree
      // around it follows. (The copy appears twice: the finally block's own
      // removal, the one that covers a throw after the child exit, is a
      // no-op once the copy is already gone.)
      expect(removed[0]).toBe(facts.path);
      expect(removed.length).toBeGreaterThan(2);
      expect(removed[1]).toBe(facts.path);
      expect(removed[2]).toBe(dirname(dirname(dirname(facts.path))));
      // Gone the moment the probe's child was gone.
      expect(existsSync(facts.path)).toBe(false);
    } finally {
      cleanup(s);
    }
  });

  test("the copy holds the configured key and the stub's base URL", async () => {
    const s = scratch();
    const captured: { copy?: { key: string; baseUrl: string }; stub?: RouterStub } = {};
    const capturing = fakeClaudeProc();
    const runProc = async (...args: Parameters<typeof capturing.runProc>) => {
      const env = args[2].env ?? {};
      const path = join(env.XDG_CONFIG_HOME as string, "claudes", "config.json");
      // Parse the copy while it is on disk: it is deleted the moment the
      // child exits, so there is nothing left to read afterwards.
      const text = readFileSync(path, "utf8");
      captured.copy = JSON.parse(text) as { key: string; baseUrl: string };
      return await capturing.runProc(...args);
    };
    try {
      const result = await checkWiring(
        deps(s, runProc, {
          createStub: async () => {
            captured.stub = await createRouterStub();
            return captured.stub;
          },
        }),
        sampleConfig(),
      );
      expect(result.status).toBe("PASS");
      const copy = captured.copy;
      expect(copy).toBeDefined();
      // The copy holds the configured key: compared by hash, so a failing
      // assertion never prints the key itself.
      expect(credentialHash(copy?.key ?? "")).toBe(credentialHash(KEY));
      // And the stub's base URL — the probe config must agree with the stub,
      // or `claudes key` refuses to serve the key for it. The stub's URL is
      // the expected value: the probe creates the stub, so on the PASS path
      // it exists, and an absent one fails the comparison instead of
      // passing it.
      const baseUrl = copy?.baseUrl ?? "";
      expect(captured.stub?.baseUrl).toBe(baseUrl);
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
    } finally {
      cleanup(s);
    }
  });

  test("the key's only disk copy is gone on the FAIL path too", async () => {
    const s = scratch();
    const capturing = fakeClaudeProc({ credential: FOREIGN_CREDENTIAL });
    let copy: string | undefined;
    const runProc = async (...args: Parameters<typeof capturing.runProc>) => {
      const env = args[2].env ?? {};
      copy = join(env.XDG_CONFIG_HOME as string, "claudes", "config.json");
      expect(existsSync(copy)).toBe(true);
      return await capturing.runProc(...args);
    };
    try {
      const result = await checkWiring(deps(s, runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(existsSync(copy as string)).toBe(false);
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
    } finally {
      cleanup(s);
    }
  });

  test("a probe tree whose pid is dead is swept; a live pid's tree is left alone", async () => {
    const s = scratch();
    const dead = join(s.dir, `probe.${DEAD_PID}`);
    const live = join(s.dir, `probe.${process.ppid}`);
    mkdirSync(dead, { recursive: true, mode: 0o700 });
    mkdirSync(live, { recursive: true, mode: 0o700 });
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("PASS");
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      cleanup(s);
    }
  });

  test("the sweep leaves entries that are not probe trees alone", async () => {
    const s = scratch();
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
    // None of these is a probe tree: `probe.0` names no pid a doctor run
    // could have had, and `probe.abc` is not a pid at all.
    const notTrees = ["probe.0", "probe.abc"];
    for (const name of notTrees) {
      mkdirSync(join(s.dir, name), { recursive: true, mode: 0o700 });
    }
    // The user's own config is not the probe's to remove either.
    writeFileSync(join(s.dir, "config.json"), "{}\n");
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("PASS");
      for (const name of notTrees) {
        expect(existsSync(join(s.dir, name))).toBe(true);
      }
      expect(existsSync(join(s.dir, "config.json"))).toBe(true);
    } finally {
      cleanup(s);
    }
  });

  for (const signal of PROBE_SIGNALS) {
    test(`a ${signal} during the probe deletes the key copy before the process dies`, async () => {
      const s = scratch();
      const trap = trapSignals();
      const capturing = fakeClaudeProc();
      let copy: string | undefined;
      const runProc = async (...args: Parameters<typeof capturing.runProc>) => {
        const env = args[2].env ?? {};
        copy = join(env.XDG_CONFIG_HOME as string, "claudes", "config.json");
        expect(existsSync(copy)).toBe(true);
        // Both signals are trapped while the copy is on disk.
        for (const trapped of PROBE_SIGNALS) {
          expect(trap.fired.has(trapped)).toBe(true);
        }
        // The interrupt arrives while the probe's child is still running.
        trap.fired.get(signal)?.();
        expect(existsSync(copy)).toBe(false);
        return await capturing.runProc(...args);
      };
      try {
        const result = await checkWiring(
          deps(s, runProc, { signals: trap.wiring }),
          sampleConfig(),
        );
        // The interrupt took the copy, not the probe's verdict.
        expect(result.status).toBe("PASS");
        // The signal was re-raised, so the process still dies of it.
        expect(trap.raised).toEqual([signal]);
        // The traps are unwired once the probe is over.
        expect(trap.fired.size).toBe(0);
        expect(existsSync(copy as string)).toBe(false);
      } finally {
        cleanup(s);
      }
    });

    test(`a ${signal} during cleanup still finds the key copy gone`, async () => {
      const s = scratch();
      const trap = trapSignals();
      let copy: string | undefined;
      // What the request sink recorded: the seam hands it to evaluate() as
      // the stub's records, so the check still judges what arrived over HTTP.
      const records: {
        method: string;
        pathname: string;
        credentials: { header: "x-api-key"; hash: string }[];
        model: string | undefined;
      }[] = [];
      const runProc: Parameters<typeof checkWiring>[0]["runProc"] = async (
        _command,
        argv,
        procOptions,
      ) => {
        const env = procOptions.env ?? {};
        copy = join(env.XDG_CONFIG_HOME as string, "claudes", "config.json");
        const settingsAt = argv.indexOf("--settings");
        const settingsPath = settingsAt === -1 ? undefined : argv[settingsAt + 1];
        expect(settingsPath).toBeDefined();
        const settings = JSON.parse(readFileSync(settingsPath as string, "utf8")) as {
          readonly env: Record<string, string>;
        };
        // The probe's verdict needs the stub to have seen the key, but the
        // seam's close() is stalled below, so this request cannot go to the
        // real recording server — its closeAllConnections() would abort the
        // fetch, and the probe would never reach the parked close() under
        // test. A throwaway sink records the request instead and is closed
        // before runProc returns.
        const sink = httpCreateServer((req, res) => {
          records.push({
            method: req.method ?? "",
            pathname: (req.url ?? "").split("?")[0] ?? "",
            credentials: [{ header: "x-api-key", hash: credentialHash(KEY) }],
            model: TIERS.sonnet,
          });
          res.end();
        });
        const port = await new Promise<number>((resolve) => {
          sink.listen(0, "127.0.0.1", () => {
            const address = sink.address();
            resolve(typeof address === "object" && address !== null ? address.port : 0);
          });
        });
        await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": KEY },
          body: JSON.stringify({ model: settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL }),
        });
        sink.close();
        return { ok: true, code: 0, signal: null, timedOut: false, stdout: "" };
      };
      // A close() that stalls in a semaphore: the probe's cleanup cannot pass
      // it until the test releases it — the finding's window, where a signal
      // used to strand the copy.
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closing = false;
      try {
        const pending = checkWiring(
          deps(s, runProc, {
            signals: trap.wiring,
            createStub: async () => ({
              baseUrl: "http://127.0.0.1:1",
              requests: () => records,
              close: async () => {
                closing = true;
                await gate;
              },
            }),
          }),
          sampleConfig(),
        );
        // Wait until the probe is parked inside its stalled close(). The
        // yield is a macrotask: a microtask spin would starve the loop and
        // the parked probe would never get to set the flag.
        while (!closing) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1);
          });
        }
        expect(copy).toBeDefined();
        // The copy is deleted before the traps come off and before the close
        // is awaited, so the interrupt arriving here finds nothing to strand.
        expect(existsSync(copy as string)).toBe(false);
        // The traps are already unwired when the probe is parked in close(),
        // so a late signal finds no handler and is not swallowed by one.
        expect(trap.fired.size).toBe(0);
        expect(trap.raised).toEqual([]);
        release?.();
        const result = await pending;
        expect(result.status).toBe("PASS");
      } finally {
        release?.();
        cleanup(s);
      }
    });
  }

  test("FAILs with the errno token when the probe tree cannot be created", async () => {
    const s = scratch();
    const eacces = new Error("mkdir: permission denied") as Error & { code: string };
    eacces.code = "EACCES";
    const fake = fakeClaudeProc();
    const result = await checkWiring(
      {
        ...deps(s, fake.runProc),
        probeDir: () => {
          throw eacces;
        },
      },
      sampleConfig(),
    );
    expect(result.status).toBe("FAIL");
    expect(result.title).toContain("could not run (EACCES)");
  });

  test("FAILs when the config directory is a symlink: the copy never lands in its target", async () => {
    const s = scratch();
    // The config directory is a symlink to a directory outside the config
    // tree: mkdir would follow it, and the documented uninstall removes the
    // link, not the target.
    const target = join(s.home, "linked-elsewhere");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(s.dir), { recursive: true, mode: 0o700 });
    symlinkSync(target, s.dir);
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      // The verdict names the symlink.
      expect(result.title).toContain("symbolic link");
      expect(result.title).toContain(s.dir);
      // Nothing was written into the link's target: no probe tree, no copy.
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(join(target, `probe.${process.pid}`))).toBe(false);
      // And the probe's child never ran.
      expect(fake.calls.length).toBe(0);
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when the probe's tree path is a symlink: the copy never lands in its target", async () => {
    const s = scratch();
    // The tree's own path is a link to a directory outside the config tree:
    // mkdir and chmod follow it, so the copy would land in the target — where
    // neither the sweep nor the documented uninstall reaches it.
    const target = join(s.home, "linked-elsewhere");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
    const tree = join(s.dir, `probe.${process.pid}`);
    symlinkSync(target, tree);
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      // The verdict names the link.
      expect(result.title).toContain("symbolic link");
      expect(result.title).toContain(tree);
      // Nothing was written into the link's target: no tree, no copy.
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(join(target, "xdg", "claudes", "config.json"))).toBe(false);
      // And the probe's child never ran.
      expect(fake.calls.length).toBe(0);
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when a directory inside the probe's tree is a symlink: the copy never lands in its target", async () => {
    const s = scratch();
    const target = join(s.home, "linked-elsewhere");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    // A tree left behind by an earlier run, with a link planted inside it.
    const tree = join(s.dir, `probe.${process.pid}`);
    mkdirSync(tree, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(tree, "xdg"));
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("symbolic link");
      // Nothing was written into the link's target.
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(join(target, "claudes", "config.json"))).toBe(false);
      // And the probe's child never ran.
      expect(fake.calls.length).toBe(0);
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when the key's only disk copy cannot be deleted, and keeps the signal traps armed", async () => {
    const s = scratch();
    const trap = trapSignals();
    const tree = join(s.dir, `probe.${process.pid}`);
    const copy = join(tree, "xdg", "claudes", "config.json");
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(
        deps(s, fake.runProc, {
          signals: trap.wiring,
          rm: (path) => {
            // Nothing under the probe's tree can be removed: the copy stays.
            if (path.startsWith(tree)) {
              throw new Error("cannot remove");
            }
            rmSync(path, { recursive: true, force: true });
          },
        }),
        sampleConfig(),
      );
      // The probe does not claim a clean run while the copy is on disk.
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("could not be deleted");
      expect(result.title).toContain(copy);
      expect(existsSync(copy)).toBe(true);
      // The traps stay armed: a signal arriving during the teardown still
      // finds the copy to delete.
      expect(trap.fired.size).toBe(PROBE_SIGNALS.length);
      expect(trap.raised).toEqual([]);
      assertNoKeyFragment(result.title, KEY);
      assertNoKeyFragment(result.fix ?? "", KEY);
    } finally {
      cleanup(s);
    }
  });

  test("PROVEN NEGATIVE: FAILs when the settings file is removed before claude reads it", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ removeSettings: true });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("without sending a request to the probe");
      expect(result.title).toContain("exited 1");
      expect(result.fix).toContain("settings file");
    } finally {
      cleanup(s);
    }
  });

  test("PROVEN NEGATIVE: FAILs when a different credential reaches the stub", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ credential: FOREIGN_CREDENTIAL });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("other than the configured router key");
      expect(result.fix).toContain("conflicts check");
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when the request's model is not a configured tier", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ model: "claude-opus-9-9" });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("claude-opus-9-9");
      expect(result.title).toContain("not a configured tier");
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when claude is missing from PATH", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(
        { ...deps(s, fake.runProc), claudePath: undefined },
        sampleConfig(),
      );
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("claude not found on PATH");
      // No probe tree was created for a probe that never ran.
      expect(existsSync(s.dir)).toBe(false);
    } finally {
      cleanup(s);
    }
  });

  test("FAILs with a remedy when the launcher's argv builder refuses the probe's arguments", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc();
      const seen: { args: readonly string[]; settingsPath: string }[] = [];
      const result = await checkWiring(
        {
          ...deps(s, fake.runProc),
          // The launcher's real refusal, produced by the production builder:
          // a key-shaped token is refused by naming the shape, never the value.
          buildArgv: (args, settingsPath) => {
            seen.push({ args: [...args], settingsPath });
            return buildArgv([KEY], settingsPath);
          },
        },
        sampleConfig(),
      );
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("refusing an argument that looks like a router key");
      // The remedy every doctor FAIL line owes the reader.
      expect(result.fix).toBeDefined();
      expect(result.fix ?? "").toContain("update claudes");
      // Neither the title nor the remedy carries the key, not even a fragment.
      expect(result.title).not.toContain(KEY);
      assertNoKeyFragment(`${result.title}\n${result.fix ?? ""}`, KEY);
      // The probe's own arguments are unchanged, and the probe never ran.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.args).toEqual([...WIRING_ARGS]);
      expect(fake.calls).toHaveLength(0);
    } finally {
      cleanup(s);
    }
  });

  test("WARNs when the credential path is proven but claude exits non-zero", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ exitCode: 3 });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("WARN");
      expect(result.title).toContain("exited 3");
    } finally {
      cleanup(s);
    }
  });

  test("FAILs on timeout with the seconds named", async () => {
    const s = scratch();
    try {
      const runProc = async () => ({
        ok: false,
        code: null,
        signal: null,
        timedOut: true,
        stdout: "",
      });
      const result = await checkWiring({ ...deps(s, runProc), timeoutMs: 60_000 }, sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("did not finish within 60 s");
    } finally {
      cleanup(s);
    }
  });
});
