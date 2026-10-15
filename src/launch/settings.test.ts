import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { Config } from "../config/schema";
import { assertNoKeyFragment } from "../test-support/redact";
import { PROVIDER_SWITCHES } from "./provider-switches";
import { buildKeyHelper, buildSettings, shellQuote } from "./settings";

const SELF = { nodePath: "/usr/local/bin/node", scriptPath: "/opt/claudes/bin/claudes.js" };

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    baseUrl: "https://router.example.test",
    key: "mar_live_FAKEKEYabcdef0123456789abcdefghi",
    tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    ...overrides,
  };
}

describe("buildKeyHelper", () => {
  test("is a /bin/sh command quoting both paths, then the key subcommand", () => {
    expect(buildKeyHelper(SELF)).toBe("'/usr/local/bin/node' '/opt/claudes/bin/claudes.js' key");
  });

  test("single-quotes embedded single quotes the sh way", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("a path with spaces and quotes survives a real /bin/sh parse", () => {
    const awkward = {
      nodePath: "/opt/my node/bin/node",
      scriptPath: "/opt/my claudes/it's dir/claudes.js",
    };
    const helper = buildKeyHelper(awkward);
    // `set -- <helper>` makes sh itself split the helper exactly as Claude Code
    // would; the three words must come back out verbatim.
    const res = spawnSync("/bin/sh", ["-c", `set -- ${helper}\nprintf '%s\\n' "$1" "$2" "$3"`], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${awkward.nodePath}\n${awkward.scriptPath}\nkey\n`);
  });
});

describe("buildSettings", () => {
  test("emits the helper-only settings shape in full", () => {
    expect(
      buildSettings(config({ subagentModel: "claude-haiku-4-5", maxContextTokens: 200_000 }), SELF),
    ).toEqual({
      apiKeyHelper: "'/usr/local/bin/node' '/opt/claudes/bin/claudes.js' key",
      permissions: { deny: ["WebSearch"] },
      env: {
        ANTHROPIC_BASE_URL: "https://router.example.test",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
        CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_USE_BEDROCK: "",
        CLAUDE_CODE_USE_VERTEX: "",
        CLAUDE_CODE_USE_FOUNDRY: "",
        CLAUDE_CODE_USE_MANTLE: "",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
        CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
        CLAUDE_CODE_USE_GATEWAY: "",
      },
    });
  });

  test("omits the optional env vars when the config has none", () => {
    const settings = buildSettings(config(), SELF);
    expect("CLAUDE_CODE_SUBAGENT_MODEL" in settings.env).toBe(false);
    expect("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in settings.env).toBe(false);
  });

  // Claude Code merges settings env per key, so a provider switch set in a user
  // or project settings file survives --settings; pinning each to "" (falsy)
  // is what keeps the session on the router.
  for (const name of PROVIDER_SWITCHES) {
    test(`pins ${name} to "" so a settings-file switch cannot reroute the session`, () => {
      expect(buildSettings(config(), SELF).env[name]).toBe("");
    });
  }

  test("carries no key material", () => {
    const settings = buildSettings(config({ subagentModel: "claude-haiku-4-5" }), SELF);
    assertNoKeyFragment(JSON.stringify(settings), config().key);
  });

  // A loopback router must never go through a proxy configured in the user's
  // or project's settings: the proxy would receive the plaintext key.
  test("a loopback baseUrl pins NO_PROXY and no_proxy to the loopback hosts", () => {
    for (const baseUrl of [
      "http://127.0.0.1:8787",
      "http://localhost:3000",
      "http://[::1]:9090",
    ] as const) {
      const env = buildSettings(config({ baseUrl }), SELF).env;
      expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
      expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
    }
  });

  test("a non-loopback baseUrl adds no proxy vars", () => {
    const env = buildSettings(config(), SELF).env;
    expect("NO_PROXY" in env).toBe(false);
    expect("no_proxy" in env).toBe(false);
  });
});
