import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { assertNoKeyFragment } from "../test-support/redact";
import { isStripped } from "./env";
import { BENIGN_USE_TOGGLES, PROVIDER_SWITCHES } from "./provider-switches";
import { FORWARDED_SIGNALS } from "./run";
import {
  cleanup,
  fakeWiring,
  type Harness,
  harness,
  KEY,
  NODE,
  SCRIPT,
  sampleConfig,
} from "./run-harness";
import { PARENT_ONLY_TRANSPORT_ENV, PINNED_TRANSPORT_ENV } from "./settings";
import { denyRules, disabledEnv } from "./unsupported";

/**
 * The success path of the launcher, guarded against the production constants
 * rather than against a transcription of them: every expectation below is
 * derived from PROVIDER_SWITCHES, PINNED_TRANSPORT_ENV,
 * PARENT_ONLY_TRANSPORT_ENV, BENIGN_USE_TOGGLES, FORWARDED_SIGNALS,
 * denyRules(), disabledEnv() and isStripped(), so a name added to any of
 * those lists is covered here the moment it is added — and a name removed
 * from the code fails the guard instead of slipping past it.
 *
 * The README guards live in src/test-support/readme-table.test.ts: they read
 * the same constants back out of the documentation, so the names the README
 * says are pinned, and the credential names it says are stripped, must be
 * the names the code knows.
 */

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(() => {
  cleanup(h);
});

/** The generated settings, as the launcher writes them. */
interface SettingsPayload {
  readonly apiKeyHelper: string;
  readonly permissions: { readonly deny: readonly string[] };
  readonly env: Record<string, string>;
}

/** The settings path the launch handed to the child. */
function settingsPath(harnessRef: Harness): string {
  const call = harnessRef.spawnCalls[0];
  if (call === undefined) {
    throw new Error("the launch never reached the spawn seam");
  }
  const path = call.argv[1];
  if (call.argv[0] !== "--settings" || path === undefined) {
    throw new Error(`the child argv does not start with --settings: ${JSON.stringify(call.argv)}`);
  }
  return path;
}

/** The settings file the launch wrote, read back from disk. */
function writtenSettings(harnessRef: Harness): {
  readonly path: string;
  readonly text: string;
  readonly payload: SettingsPayload;
} {
  const path = settingsPath(harnessRef);
  const text = readFileSync(path, "utf8");
  assertNoKeyFragment(text, KEY);
  return { path, text, payload: JSON.parse(text) as SettingsPayload };
}

/**
 * Every env key the generated settings may carry, derived from the
 * constants: the three tier pins, the credential pins, the base URL, the
 * deny/disabled features, every provider switch and every pinned transport
 * name — plus the parent-only transport names when the parent sets them.
 * Nothing else may appear: an env key no constant explains is a pin nobody
 * documented.
 */
function expectedEnvKeys(parentOnly: readonly string[]): string[] {
  return [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ...Object.keys(disabledEnv()),
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    ...PROVIDER_SWITCHES,
    ...PINNED_TRANSPORT_ENV,
    ...parentOnly,
  ];
}

/** A parent env that sets every pinned transport name, both spellings alike. */
function transportParent(harnessRef: Harness): Record<string, string> {
  return {
    HOME: harnessRef.home,
    PATH: harnessRef.binDir,
    HTTP_PROXY: "http://proxy.example.test:3128",
    http_proxy: "http://proxy.example.test:3128",
    HTTPS_PROXY: "http://secure-proxy.example.test:3129",
    https_proxy: "http://secure-proxy.example.test:3129",
    ALL_PROXY: "http://all-proxy.example.test:3130",
    all_proxy: "http://all-proxy.example.test:3130",
    NO_PROXY: "no-proxy.example.test",
    no_proxy: "no-proxy.example.test",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
    NODE_USE_ENV_PROXY: "1",
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CODE_CERT_STORE: "/corp/store",
    BUN_CONFIG_VERBOSE_FETCH: "0",
    SSL_CERT_FILE: "/corp/ssl.pem",
    SSL_CERT_DIR: "/corp/certs",
  };
}

/** A parent env carrying every kind of credential the launcher must strip. */
function credentialParent(harnessRef: Harness): Record<string, string> {
  return {
    HOME: harnessRef.home,
    PATH: harnessRef.binDir,
    ANTHROPIC_AUTH_TOKEN: "sk-ant-personal",
    ANTHROPIC_API_KEY: "sk-ant-api-personal",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-ai-personal",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-personal",
    ...Object.fromEntries(PROVIDER_SWITCHES.map((name) => [name, "1"])),
    ...Object.fromEntries(BENIGN_USE_TOGGLES.map((name) => [name, "1"])),
    EDITOR: "vim",
  };
}

/** Node's own signal number for a name — the table the launcher answers with. */
function signalNumber(signal: string): number {
  const table = osConstants.signals as Record<string, number | undefined>;
  return table[signal] ?? 0;
}

describe("run success path: the launch", () => {
  test("writes the settings file, spawns claude exactly once, and answers the child's exit code", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir },
      spawnScript: (child) => child.emit("exit", 7, null),
    });
    expect(code).toBe(7);
    // A refusal code would mean the launch never reached the spawn seam.
    expect([64, 69, 78, 127]).not.toContain(code);
    expect(h.spawnCalls.length).toBe(1);
    expect(existsSync(settingsPath(h))).toBe(true);
    // The success path prints nothing at all.
    expect(h.err.join("")).toBe("");
    assertNoKeyFragment(h.err.join(""), KEY);
  });
});

describe("run success path: the settings payload", () => {
  test("carries every constant's name and no env key beyond them", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    const { payload } = writtenSettings(h);
    expect(Object.keys(payload.env).sort()).toEqual(expectedEnvKeys([]).sort());
    // The helper the key is served through, quoted for /bin/sh.
    expect(payload.apiKeyHelper).toBe(`'${NODE}' '${SCRIPT}' key`);
  });

  test("pins every provider switch and both credential vars to empty", async () => {
    await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    const { payload } = writtenSettings(h);
    expect(PROVIDER_SWITCHES.length).toBeGreaterThan(0);
    expect(payload.env).toMatchObject(
      Object.fromEntries(PROVIDER_SWITCHES.map((name) => [name, ""])),
    );
    // The session never carries a personal credential: both vars are blanked.
    expect(payload.env.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(payload.env.ANTHROPIC_API_KEY).toBe("");
  });

  test("pins the base URL and the three tiers to the config's own values", async () => {
    await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    const { payload } = writtenSettings(h);
    const config = sampleConfig();
    expect(payload.env.ANTHROPIC_BASE_URL).toBe(config.baseUrl);
    expect(payload.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(config.tiers.opus);
    expect(payload.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(config.tiers.sonnet);
    expect(payload.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(config.tiers.haiku);
  });

  test("denies exactly the unsupported features' rules and env", async () => {
    await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    const { payload } = writtenSettings(h);
    expect(payload.permissions.deny).toEqual(denyRules());
    expect(Object.keys(disabledEnv()).length).toBeGreaterThan(0);
    expect(payload.env).toMatchObject(disabledEnv());
  });

  test("pins every transport name to the parent's own value", async () => {
    const parent = transportParent(h);
    const code = await h.drive(["-p", "hi"], {
      env: parent,
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    const { payload } = writtenSettings(h);
    expect(PINNED_TRANSPORT_ENV.length).toBeGreaterThan(0);
    for (const name of PINNED_TRANSPORT_ENV) {
      expect(payload.env[name]).toBe(parent[name]);
    }
    // The parent-only names ride along when the parent sets them.
    expect(PARENT_ONLY_TRANSPORT_ENV.length).toBeGreaterThan(0);
    for (const name of PARENT_ONLY_TRANSPORT_ENV) {
      expect(payload.env[name]).toBe(parent[name]);
    }
    expect(Object.keys(payload.env).sort()).toEqual(
      expectedEnvKeys(PARENT_ONLY_TRANSPORT_ENV).sort(),
    );
  });

  test("pins every transport name to empty and omits the parent-only names when the parent has none", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: { HOME: h.home, PATH: h.binDir },
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    const { payload } = writtenSettings(h);
    for (const name of PINNED_TRANSPORT_ENV) {
      expect(payload.env[name]).toBe("");
    }
    for (const name of PARENT_ONLY_TRANSPORT_ENV) {
      expect(name in payload.env).toBe(false);
    }
  });
});

describe("run success path: the child environment", () => {
  test("no name the launcher strips survives in the child env", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: credentialParent(h),
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    const child = h.spawnCalls[0]?.env ?? {};
    // The launcher's own rule, applied to what the child actually got: the
    // check cannot be vacuous, the child's env is not empty.
    expect(Object.keys(child).length).toBeGreaterThan(0);
    for (const name of Object.keys(child)) {
      expect(isStripped(name)).toBe(false);
    }
    // Every provider switch is gone by name.
    expect(PROVIDER_SWITCHES.length).toBeGreaterThan(0);
    for (const name of PROVIDER_SWITCHES) {
      expect(name in child).toBe(false);
    }
    // The parent's personal credential is gone entirely, not blanked.
    expect("ANTHROPIC_AUTH_TOKEN" in child).toBe(false);
    expect(Object.values(child)).not.toContain("sk-ant-personal");
    assertNoKeyFragment(JSON.stringify(child), KEY);
  });

  test("every benign toggle survives and does not block the launch", async () => {
    const code = await h.drive(["-p", "hi"], {
      env: credentialParent(h),
      spawnScript: (child) => child.emit("exit", 0, null),
    });
    expect(code).toBe(0);
    const child = h.spawnCalls[0]?.env ?? {};
    expect(BENIGN_USE_TOGGLES.length).toBeGreaterThan(0);
    for (const name of BENIGN_USE_TOGGLES) {
      expect(child[name]).toBe("1");
    }
    // The developer's own environment survives untouched.
    expect(child.EDITOR).toBe("vim");
    expect(child.PATH).toBe(h.binDir);
  });
});

describe("run success path: the signal lifecycle", () => {
  for (const signal of FORWARDED_SIGNALS) {
    test(`${signal} reaches the child, and a signal death answers 128+n`, async () => {
      const { wiring, fired } = fakeWiring();
      let wiredWhileRunning = 0;
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir },
        wiring,
        spawnScript: (child) => {
          queueMicrotask(() => {
            wiredWhileRunning = fired.size;
            fired.get(signal)?.();
            child.emit("exit", null, signal);
          });
        },
      });
      // Every forwarded signal has a handler while the child runs.
      expect(wiredWhileRunning).toBe(FORWARDED_SIGNALS.length);
      // The signal reached the child, and nothing else was forwarded.
      expect(h.children[0]?.kills).toEqual([signal]);
      expect(code).toBe(128 + signalNumber(signal));
      // The handlers come off once the child is gone.
      expect(fired.size).toBe(0);
    });
  }

  test("the child's own exit code passes through", async () => {
    for (const expected of [0, 1, 7, 64]) {
      const code = await h.drive(["-p", "hi"], {
        env: { HOME: h.home, PATH: h.binDir },
        spawnScript: (child) => child.emit("exit", expected, null),
      });
      expect(code).toBe(expected);
    }
  });
});
