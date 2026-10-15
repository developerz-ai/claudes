import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configFile, settingsFile } from "../config/paths";
import { writeConfig } from "../config/store";
import { assertNoKeyFragment } from "../test-support/redact";
import { CLAUDE_NOT_FOUND_MESSAGE } from "./run";
import {
  cleanup,
  deadFetch,
  type Harness,
  harness,
  KEY,
  NODE,
  ROUTER,
  SCRIPT,
} from "./run-harness";

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

/** This launch's settings path, as run() computes it (the test runs in-process). */
function launchSettings(): string {
  return settingsFile(h.dir, process.pid);
}

describe("run: config gate", () => {
  test("no config at all: exit 78, the exact remedy, nothing spawned", async () => {
    rmSync(h.home, { recursive: true, force: true });
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
    expect(h.spawnCalls).toEqual([]);
  });

  test("no usable HOME: same missing-config refusal", async () => {
    const code = await h.drive(["-p", "hi"], { env: { PATH: "/bin", HOME: undefined } });
    expect(code).toBe(78);
    expect(errText()).toBe(`${MISSING_CONFIG_MESSAGE}\n`);
  });

  test("a base URL but no key (schema-invalid): exit 78, the store's message", async () => {
    rmSync(configFile(h.dir));
    writeFileSync(
      configFile(h.dir),
      JSON.stringify({ version: 1, baseUrl: ROUTER, tiers: {} }),
      "utf8",
    );
    chmodSync(configFile(h.dir), 0o600);
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toContain("not a valid claudes config");
    expect(h.spawnCalls).toEqual([]);
  });

  test("insecure config perms: exit 78, the store's refusal", async () => {
    chmodSync(configFile(h.dir), 0o644);
    const code = await h.drive(["-p", "hi"]);
    expect(code).toBe(78);
    expect(errText()).toContain("readable by group or other users");
    expect(h.spawnCalls).toEqual([]);
  });
});

describe("run: argv gate", () => {
  for (const args of [
    ["--settings", "/tmp/mine.json"],
    ["--key", "x"],
    ["-p", KEY],
  ] as const) {
    test(`refuses ${JSON.stringify(args)} with exit 64, before any fetch or spawn`, async () => {
      const code = await h.drive(args, { fetch: deadFetch });
      expect(code).toBe(64);
      expect(h.spawnCalls).toEqual([]);
      expect(errText()).not.toContain(KEY);
      expect(errText()).not.toContain("/tmp/mine.json");
    });
  }
});

describe("run: unknown rerouting toggle gate", () => {
  test("an unknown CLAUDE_CODE_USE_ toggle: exit 64, the refusal, before the probe or spawn", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_USE_CCR_V2: "1" },
      fetch: deadFetch,
    });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: refusing: CLAUDE_CODE_USE_CCR_V2 is set, so this session would not go to the router\n",
    );
    // deadFetch would answer 69 were the probe reached: 64 proves it was not.
    expect(h.spawnCalls).toEqual([]);
    assertNoKeyFragment(errText(), KEY);
  });

  test("a known provider switch in the parent env does not block launch", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_USE_BEDROCK: "1" },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    expect(h.spawnCalls.length).toBe(1);
  });

  test("a benign toggle does not block launch", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    expect(h.spawnCalls.length).toBe(1);
  });

  test("an unknown toggle set to a falsy value does not block launch", async () => {
    for (const value of ["", "0", "false"]) {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_USE_CCR_V2: value },
        spawnScript: (child) => child.emit("exit", 0, null),
      });
      expect(code).toBe(0);
    }
    expect(h.spawnCalls.length).toBe(3);
  });
});

describe("run: host-managed bypass gate", () => {
  test("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST truthy: exit 64, the name-only refusal, before the probe", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" },
      fetch: deadFetch,
    });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: refusing: CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set, so this session would not go to the router\n",
    );
    expect(h.spawnCalls).toEqual([]);
    assertNoKeyFragment(errText(), KEY);
  });

  test("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST falsy does not block launch", async () => {
    for (const value of ["", "0", "false"]) {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: value },
        spawnScript: (child) => child.emit("exit", 0, null),
      });
      expect(code).toBe(0);
    }
    expect(h.spawnCalls.length).toBe(3);
  });

  test("CLAUDE_CODE_HOST_AUTH_ENV_VAR set to a value: exit 64, the refusal, before the probe", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY" },
      fetch: deadFetch,
    });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: refusing: CLAUDE_CODE_HOST_AUTH_ENV_VAR is set, so this session would not go to the router\n",
    );
    expect(h.spawnCalls).toEqual([]);
  });

  // The variable names the env var holding the host's credential: "0" and
  // "false" are names like any other, so any non-empty value refuses.
  test("CLAUDE_CODE_HOST_AUTH_ENV_VAR counts '0' and 'false' as set", async () => {
    for (const value of ["0", "false"]) {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_HOST_AUTH_ENV_VAR: value },
        fetch: deadFetch,
      });
      expect(code).toBe(64);
    }
    expect(h.spawnCalls).toEqual([]);
  });

  test("CLAUDE_CODE_HOST_AUTH_ENV_VAR empty or unset does not block launch", async () => {
    for (const env of [
      { HOME: h.home, PATH: h.binDir },
      { HOME: h.home, PATH: h.binDir, CLAUDE_CODE_HOST_AUTH_ENV_VAR: "" },
    ]) {
      const code = await h.drive(["-p", "hi"], {
        env,
        spawnScript: (child) => child.emit("exit", 0, null),
      });
      expect(code).toBe(0);
    }
    expect(h.spawnCalls.length).toBe(2);
  });
});

describe("run: verbose-fetch gate", () => {
  test("BUN_CONFIG_VERBOSE_FETCH truthy: exit 64, the refusal, before the probe", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir, BUN_CONFIG_VERBOSE_FETCH: "1" },
      fetch: deadFetch,
    });
    expect(code).toBe(64);
    expect(errText()).toBe(
      "claudes: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed\n",
    );
    // deadFetch would answer 69 were the probe reached: 64 proves it was not.
    expect(h.spawnCalls).toEqual([]);
    assertNoKeyFragment(errText(), KEY);
  });

  test("BUN_CONFIG_VERBOSE_FETCH falsy does not block launch", async () => {
    for (const value of ["", "0", "false"]) {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir, BUN_CONFIG_VERBOSE_FETCH: value },
        spawnScript: (child) => child.emit("exit", 0, null),
      });
      expect(code).toBe(0);
    }
    expect(h.spawnCalls.length).toBe(3);
  });
});

describe("run: settings file", () => {
  test("written 0600 inside the 0700 config dir, left in place once the child exits", async () => {
    let observed: { path: string; mode: number; dirMode: number; text: string } | undefined;
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => {
        // The file exists while the child runs: read it before the exit.
        const path = launchSettings();
        observed = {
          path,
          mode: statSync(path).mode & 0o777,
          dirMode: statSync(h.dir).mode & 0o777,
          text: readFileSync(path, "utf8"),
        };
        child.emit("exit", 0, null);
      },
    });
    expect(code).toBe(0);
    const seen = observed as { path: string; mode: number; dirMode: number; text: string };
    expect(seen.mode).toBe(0o600);
    expect(seen.dirMode).toBe(0o700);
    const payload = JSON.parse(seen.text);
    expect(payload.apiKeyHelper).toBe(`'${NODE}' '${SCRIPT}' key`);
    expect(payload.permissions).toEqual({ deny: ["WebSearch"] });
    expect(payload.env.ANTHROPIC_BASE_URL).toBe(ROUTER);
    expect(payload.env.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(payload.env.CLAUDE_CODE_USE_BEDROCK).toBe("");
    assertNoKeyFragment(seen.text, KEY);
    // After the child exits the file stays: Claude Code hands the --settings
    // path to processes it starts later, which read it fresh from disk.
    expect(existsSync(seen.path)).toBe(true);
  });

  test("the settings file stays behind when claude is missing from PATH", async () => {
    const code = await h.drive(["-p", "hi"], { env: { HOME: h.home, PATH: "/nonexistent" } });
    expect(code).toBe(127);
    expect(errText()).toBe(`${CLAUDE_NOT_FOUND_MESSAGE}\n`);
    // No child ever ran, but the write already happened: the file waits for a
    // later launch's sweep, like any launch whose pid has since died.
    expect(existsSync(launchSettings())).toBe(true);
  });

  test("the settings file stays behind when the spawn itself fails", async () => {
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("error", new Error("ENOENT")),
    });
    expect(code).toBe(127);
    expect(existsSync(launchSettings())).toBe(true);
  });

  test("dead launches' files, their temp siblings, and a legacy settings.json are swept", async () => {
    writeFileSync(join(h.dir, "settings.999999999.json"), "{}\n", "utf8");
    writeFileSync(join(h.dir, "settings.999999999.json.tmp-m3z1gx"), "{}\n", "utf8");
    writeFileSync(join(h.dir, "settings.json"), "{}\n", "utf8");
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    expect(existsSync(join(h.dir, "settings.999999999.json"))).toBe(false);
    expect(existsSync(join(h.dir, "settings.999999999.json.tmp-m3z1gx"))).toBe(false);
    expect(existsSync(join(h.dir, "settings.json"))).toBe(false);
  });

  test("the sweep runs before the router pre-flight: it cleans even when the router is down", async () => {
    const stale = join(h.dir, "settings.999999999.json");
    writeFileSync(stale, "{}\n", "utf8");
    const code = await h.drive(["-p", "hi"], { fetch: deadFetch });
    expect(code).toBe(69);
    expect(existsSync(stale)).toBe(false);
  });

  test("an unreachable router leaves no settings file behind", async () => {
    const code = await h.drive(["-p", "hi"], { fetch: deadFetch });
    expect(code).toBe(69);
    expect(statSync(launchSettings(), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("a symlinked config dir: the ConfigError's own message, exit 1, no spawn", async () => {
    // The config stays readable through the symlink; only the settings write
    // refuses it, because chmod through a symlink would tighten someone else's
    // directory.
    const real = `${h.home}/real-config-dir`;
    mkdirSync(real, { recursive: true });
    writeConfig(configFile(real), {
      version: 1,
      baseUrl: ROUTER,
      key: KEY,
      tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    });
    rmSync(h.dir, { recursive: true, force: true });
    symlinkSync(real, h.dir);
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(1);
    expect(errText()).toBe(
      `refusing to write settings: ${h.dir} is a symbolic link — remove it and re-run "claudes login"\n`,
    );
    expect(h.spawnCalls).toEqual([]);
  });

  test("a non-Config write failure names the errno code", async () => {
    // A directory at the settings path makes the final rename fail with an
    // errno (EISDIR/ENOTDIR), which is all the message may carry.
    mkdirSync(launchSettings());
    const code = await h.drive(["-p", "hi"], {
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/^claudes: could not write the settings file at .+ \(E[A-Z]+\)\n$/);
    expect(h.spawnCalls).toEqual([]);
  });
});

describe("run: redaction", () => {
  test("no error path ever leaks the key", async () => {
    await h.drive(["-p", "hi"], { fetch: deadFetch });
    await h.drive(["-p", KEY]);
    await h.drive(["-p", "hi"], { env: { HOME: h.home, PATH: "/nonexistent" } });
    assertNoKeyFragment(errText(), KEY);
  });
});
