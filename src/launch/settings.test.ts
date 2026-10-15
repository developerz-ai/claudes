import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { Env } from "../config/paths";
import type { Config } from "../config/schema";
import { assertNoKeyFragment } from "../test-support/redact";
import { PROVIDER_SWITCHES } from "./provider-switches";
import {
  buildKeyHelper,
  buildSettings,
  PARENT_ONLY_TRANSPORT_ENV,
  PINNED_TRANSPORT_ENV,
  shellQuote,
} from "./settings";

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
      buildSettings(
        config({ subagentModel: "claude-haiku-4-5", maxContextTokens: 200_000 }),
        SELF,
        {},
      ),
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
        HTTP_PROXY: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        https_proxy: "",
        ALL_PROXY: "",
        all_proxy: "",
        NO_PROXY: "",
        no_proxy: "",
        NODE_TLS_REJECT_UNAUTHORIZED: "",
        NODE_EXTRA_CA_CERTS: "",
        NODE_USE_ENV_PROXY: "",
        NODE_OPTIONS: "",
        CLAUDE_CODE_CERT_STORE: "",
        BUN_CONFIG_VERBOSE_FETCH: "",
      },
    });
  });

  test("omits the optional env vars when the config has none", () => {
    const settings = buildSettings(config(), SELF, {});
    expect("CLAUDE_CODE_SUBAGENT_MODEL" in settings.env).toBe(false);
    expect("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in settings.env).toBe(false);
  });

  // Claude Code merges settings env per key, so a provider switch set in a user
  // or project settings file survives --settings; pinning each to "" (falsy)
  // is what keeps the session on the router.
  for (const name of PROVIDER_SWITCHES) {
    test(`pins ${name} to "" so a settings-file switch cannot reroute the session`, () => {
      expect(buildSettings(config(), SELF, {}).env[name]).toBe("");
    });
  }

  test("carries no key material", () => {
    const settings = buildSettings(config({ subagentModel: "claude-haiku-4-5" }), SELF, {});
    assertNoKeyFragment(JSON.stringify(settings), config().key);
  });

  // A settings-file proxy or CA must not see the key: HTTPS_PROXY plus a
  // planted NODE_TLS_REJECT_UNAUTHORIZED/NODE_EXTRA_CA_CERTS would hand a
  // proxy a TLS MITM on an https router. Each pinned name carries the parent
  // env's value ("" verified to behave like unset), so the developer's own
  // shell choices still apply and a plant never wins.
  for (const name of PINNED_TRANSPORT_ENV) {
    test(`pins ${name} to the parent env's value`, () => {
      const parent: Env = { [name]: "parent-value" };
      expect(buildSettings(config(), SELF, parent).env[name]).toBe("parent-value");
    });

    test(`pins ${name} to "" when the parent env has none`, () => {
      expect(buildSettings(config(), SELF, {}).env[name]).toBe("");
    });
  }

  // NODE_OPTIONS reaches the apiKeyHelper subprocess too (`node <script> key`),
  // and Node applies a planted --require from it before the helper script runs
  // — so a cloned repo could otherwise run code inside the key helper. Both
  // parent cases are pinned so a settings-file plant can never win.
  test('pins NODE_OPTIONS to the parent env\'s value, "" when the parent has none', () => {
    expect(
      buildSettings(config(), SELF, { NODE_OPTIONS: "--max-old-space-size=4096" }).env.NODE_OPTIONS,
    ).toBe("--max-old-space-size=4096");
    expect(buildSettings(config(), SELF, {}).env.NODE_OPTIONS).toBe("");
  });

  // An SSL pin of "" is NOT unset for the OpenSSL clients (python urllib, pip,
  // wget, openssl, ruby) in every session subprocess: they would see an empty
  // CA store and fail all HTTPS with CERTIFICATE_VERIFY_FAILED. So these two
  // are emitted only when the parent has a real value.
  for (const name of PARENT_ONLY_TRANSPORT_ENV) {
    test(`emits ${name} pinned to the parent's value when the parent has one`, () => {
      expect(buildSettings(config(), SELF, { [name]: "/corp/ssl.pem" }).env[name]).toBe(
        "/corp/ssl.pem",
      );
    });

    test(`never emits ${name} when the parent env has none`, () => {
      expect(name in buildSettings(config(), SELF, {}).env).toBe(false);
    });

    test(`never emits ${name} when the parent's value is empty`, () => {
      expect(name in buildSettings(config(), SELF, { [name]: "" }).env).toBe(false);
    });
  }

  // A proxy is pinned per PAIR, never per name: tools export either case, and
  // subprocesses read either case, so one name set and its twin "" would let a
  // case-sensitive client slip around the developer's proxy intent.
  for (const [upper, lower] of [
    ["HTTP_PROXY", "http_proxy"],
    ["HTTPS_PROXY", "https_proxy"],
    ["ALL_PROXY", "all_proxy"],
  ] as const) {
    test(`${upper} only: both names pinned to its value`, () => {
      const env = buildSettings(config(), SELF, { [upper]: "http://proxy.corp.test:3128" }).env;
      expect(env[upper]).toBe("http://proxy.corp.test:3128");
      expect(env[lower]).toBe("http://proxy.corp.test:3128");
    });

    test(`${lower} only: both names pinned to its value`, () => {
      const env = buildSettings(config(), SELF, { [lower]: "http://proxy.corp.test:3128" }).env;
      expect(env[upper]).toBe("http://proxy.corp.test:3128");
      expect(env[lower]).toBe("http://proxy.corp.test:3128");
    });

    test(`${upper} and ${lower} both set: each keeps its own value`, () => {
      const env = buildSettings(config(), SELF, {
        [upper]: "http://upper.corp.test:3128",
        [lower]: "http://lower.corp.test:3128",
      }).env;
      expect(env[upper]).toBe("http://upper.corp.test:3128");
      expect(env[lower]).toBe("http://lower.corp.test:3128");
    });

    test(`neither ${upper} nor ${lower} set: both names pinned to ""`, () => {
      const env = buildSettings(config(), SELF, {}).env;
      expect(env[upper]).toBe("");
      expect(env[lower]).toBe("");
    });

    test(`an empty-string ${upper} is no proxy: both names end up ""`, () => {
      const env = buildSettings(config(), SELF, { [upper]: "" }).env;
      expect(env[upper]).toBe("");
      expect(env[lower]).toBe("");
    });
  }

  // NO_PROXY/no_proxy merge instead: both names carry ONE value, so no client
  // reading either case bypasses the developer's no-proxy list.
  test("NO_PROXY only: both names pinned to the merged value", () => {
    const env = buildSettings(config(), SELF, { NO_PROXY: "10.0.0.1,.corp.test" }).env;
    expect(env.NO_PROXY).toBe("10.0.0.1,.corp.test");
    expect(env.no_proxy).toBe("10.0.0.1,.corp.test");
  });

  test("no_proxy only: both names pinned to the merged value", () => {
    const env = buildSettings(config(), SELF, { no_proxy: "10.0.0.2" }).env;
    expect(env.NO_PROXY).toBe("10.0.0.2");
    expect(env.no_proxy).toBe("10.0.0.2");
  });

  test("both parent cases: merged, deduped, uppercase entries first, in both names", () => {
    const env = buildSettings(config(), SELF, {
      NO_PROXY: "10.0.0.1,.corp.test",
      no_proxy: ".corp.test,10.0.0.2",
    }).env;
    expect(env.NO_PROXY).toBe("10.0.0.1,.corp.test,10.0.0.2");
    expect(env.no_proxy).toBe("10.0.0.1,.corp.test,10.0.0.2");
  });

  test('neither parent case: both names pinned to ""', () => {
    const env = buildSettings(config(), SELF, {}).env;
    expect(env.NO_PROXY).toBe("");
    expect(env.no_proxy).toBe("");
  });

  test("an https router freezes the whole transport set from the parent env", () => {
    const parent: Env = {
      HTTPS_PROXY: "http://proxy.corp.test:3128",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
      NODE_USE_ENV_PROXY: "1",
      SSL_CERT_FILE: "/corp/ssl.pem",
      SSL_CERT_DIR: "/corp/certs",
      CLAUDE_CODE_CERT_STORE: "/corp/store",
      BUN_CONFIG_VERBOSE_FETCH: "0",
    };
    const env = buildSettings(config(), SELF, parent).env;
    expect(env.HTTPS_PROXY).toBe("http://proxy.corp.test:3128");
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/corp/ca.pem");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.SSL_CERT_FILE).toBe("/corp/ssl.pem");
    expect(env.SSL_CERT_DIR).toBe("/corp/certs");
    expect(env.CLAUDE_CODE_CERT_STORE).toBe("/corp/store");
    expect(env.BUN_CONFIG_VERBOSE_FETCH).toBe("0");
    // And a value some settings file planted cannot win: the pin is the
    // parent's (here, "").
    expect(env.HTTP_PROXY).toBe("");
  });

  // A loopback router must never go through a proxy configured in the user's
  // or project's settings: the proxy would receive the plaintext key. The
  // router's own hostname is pinned too — not every proxy client reads
  // 127.0.0.0/8 as a range, only literal hosts.
  test("a loopback baseUrl pins NO_PROXY and no_proxy to the loopback hosts plus the router's own", () => {
    for (const [baseUrl, expected] of [
      ["http://127.0.0.1:8787", "127.0.0.1,localhost,::1"],
      ["http://localhost:3000", "127.0.0.1,localhost,::1"],
      ["http://[::1]:9090", "127.0.0.1,localhost,::1,[::1]"],
      ["http://127.0.0.2:8787", "127.0.0.1,localhost,::1,127.0.0.2"],
      ["http://127.255.255.254:8787", "127.0.0.1,localhost,::1,127.255.255.254"],
    ] as const) {
      const env = buildSettings(config({ baseUrl }), SELF, {}).env;
      expect(env.NO_PROXY).toBe(expected);
      expect(env.no_proxy).toBe(expected);
    }
  });

  test("a 127.0.0.0/8 router merges its hostname ahead of the parent's entries", () => {
    const env = buildSettings(config({ baseUrl: "http://127.0.0.2:8787" }), SELF, {
      NO_PROXY: "10.0.0.1,.corp.test",
    }).env;
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1,127.0.0.2,10.0.0.1,.corp.test");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1,127.0.0.2,10.0.0.1,.corp.test");
  });

  test("a non-loopback host — even a 127.x-looking one — earns no loopback pin", () => {
    for (const baseUrl of [
      "http://128.0.0.1:8787", // in-range IPv4, outside 127.0.0.0/8
      "http://127.0.0.256:8787", // not a valid IPv4: the URL does not parse, so not loopback
      "http://example.127.0.0.1:8787", // same: any host ending in a number must parse as IPv4
    ] as const) {
      const env = buildSettings(config({ baseUrl }), SELF, {}).env;
      expect(env.NO_PROXY).toBe("");
    }
  });

  test("a loopback baseUrl with a parent NO_PROXY only puts the entries into BOTH names", () => {
    const env = buildSettings(config({ baseUrl: "http://127.0.0.1:8787" }), SELF, {
      NO_PROXY: "10.0.0.1,.corp.test",
    }).env;
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1,10.0.0.1,.corp.test");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1,10.0.0.1,.corp.test");
  });

  test("a loopback baseUrl merges both parent cases after the loopback hosts, deduped", () => {
    const env = buildSettings(config({ baseUrl: "http://localhost:3000" }), SELF, {
      NO_PROXY: "10.0.0.1,localhost",
      no_proxy: "10.0.0.2",
    }).env;
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1,10.0.0.1,10.0.0.2");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1,10.0.0.1,10.0.0.2");
  });

  test("a loopback baseUrl with empty parent values pins only the loopback hosts", () => {
    const env = buildSettings(config({ baseUrl: "http://localhost:3000" }), SELF, {
      NO_PROXY: "",
      no_proxy: undefined,
    }).env;
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
  });

  test("a non-loopback baseUrl pins both NO_PROXY names to the merged parent value", () => {
    const env = buildSettings(config(), SELF, { NO_PROXY: "10.0.0.1,.corp.test" }).env;
    expect(env.NO_PROXY).toBe("10.0.0.1,.corp.test");
    expect(env.no_proxy).toBe("10.0.0.1,.corp.test");
    expect(buildSettings(config(), SELF, {}).env.NO_PROXY).toBe("");
  });
});
