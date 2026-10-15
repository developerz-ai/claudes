import { describe, expect, test } from "bun:test";
import { checkConflicts } from "./conflicts";

const HOME = "/home/dev";
const CWD = "/repo";

function files(map: Record<string, string>): (path: string) => string | undefined {
  return (path) => map[path];
}

function deps(overrides: Partial<Parameters<typeof checkConflicts>[0]> = {}) {
  return {
    env: {},
    platform: "linux",
    cwd: CWD,
    readFile: files({}),
    ...overrides,
  };
}

describe("checkConflicts: shell env", () => {
  test("a clean shell passes", () => {
    const results = checkConflicts(deps());
    expect(results[0]).toEqual({
      status: "PASS",
      title: "the shell env sets no router-relevant credentials",
    });
  });

  test("ANTHROPIC_*, the OAuth token and CLAUDE_CODE_USE_* are INFO, names only", () => {
    const results = checkConflicts(
      deps({
        env: {
          HOME,
          ANTHROPIC_API_KEY: "sk-ant-secret",
          ANTHROPIC_AUTH_TOKEN: "sk-ant-secret",
          CLAUDE_CODE_OAUTH_TOKEN: "claude-ai-secret",
          CLAUDE_CODE_USE_BEDROCK: "1",
          EDITOR: "vim",
        },
      }),
    );
    const info = results[0];
    expect(info?.status).toBe("INFO");
    expect(info?.title).toContain(
      "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK",
    );
    expect(info?.title).toContain("stripped for claudes; affects plain claude");
    // Names only: no value from the env appears.
    expect(info?.title).not.toContain("sk-ant-secret");
    expect(info?.title).not.toContain("claude-ai-secret");
  });

  test("empty values do not count as set (presence means a non-empty value)", () => {
    const results = checkConflicts(
      deps({ env: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" } }),
    );
    expect(results[0]?.status).toBe("PASS");
  });
});

describe("checkConflicts: user, project and local settings", () => {
  test("clean or absent settings pass", () => {
    const results = checkConflicts(deps({ env: { HOME } }));
    expect(results[1]?.status).toBe("PASS");
  });

  test("env keys, apiKeyHelper and forceLoginMethod WARN by name only", () => {
    const results = checkConflicts(
      deps({
        env: { HOME },
        readFile: files({
          [`${HOME}/.claude/settings.json`]: JSON.stringify({
            env: { ANTHROPIC_BASE_URL: "https://evil.example", CLAUDE_CODE_USE_VERTEX: "1" },
            forceLoginMethod: "claudeai",
          }),
          [`${CWD}/.claude/settings.local.json`]: JSON.stringify({ apiKeyHelper: "/bin/leak" }),
        }),
      }),
    );
    const warn = results[1];
    expect(warn?.status).toBe("WARN");
    expect(warn?.title).toContain("user settings");
    expect(warn?.title).toContain("env.ANTHROPIC_BASE_URL");
    expect(warn?.title).toContain("env.CLAUDE_CODE_USE_VERTEX");
    expect(warn?.title).toContain("forceLoginMethod");
    expect(warn?.title).toContain("local settings");
    expect(warn?.title).toContain("apiKeyHelper");
    // Names only: the planted values never appear.
    expect(warn?.title).not.toContain("evil.example");
    expect(warn?.title).not.toContain("/bin/leak");
  });

  test("an unparsable settings file WARNs as such", () => {
    const results = checkConflicts(
      deps({ env: { HOME }, readFile: files({ [`${HOME}/.claude/settings.json`]: "{oops" }) }),
    );
    expect(results[1]?.status).toBe("WARN");
    expect(results[1]?.title).toContain("could not be parsed as JSON");
  });

  test("no HOME directory WARNs that user settings could not be looked at", () => {
    const results = checkConflicts(deps({ env: {} }));
    expect(results[1]?.status).toBe("WARN");
    expect(results[1]?.title).toContain("no home directory");
  });
});

describe("checkConflicts: managed settings", () => {
  test("absent managed settings pass", () => {
    const results = checkConflicts(deps());
    expect(results[2]?.status).toBe("PASS");
    expect(results[2]?.title).toContain("/etc/claude-code/managed-settings.json");
  });

  test("managed settings that outrank --settings FAIL, names only", () => {
    const results = checkConflicts(
      deps({
        readFile: files({
          "/etc/claude-code/managed-settings.json": JSON.stringify({
            env: { ANTHROPIC_API_KEY: "managed-secret" },
            apiKeyHelper: "/usr/bin/corporate-helper",
          }),
        }),
      }),
    );
    const fail = results[2];
    expect(fail?.status).toBe("FAIL");
    expect(fail?.title).toContain("outrank --settings");
    expect(fail?.title).toContain("env.ANTHROPIC_API_KEY");
    expect(fail?.title).toContain("apiKeyHelper");
    expect(fail?.title).not.toContain("managed-secret");
    expect(fail?.fix).toContain("/etc/claude-code/managed-settings.json");
  });

  test("the macOS path is used on darwin", () => {
    const results = checkConflicts(
      deps({
        platform: "darwin",
        readFile: files({
          "/Library/Application Support/ClaudeCode/managed-settings.json": JSON.stringify({
            model: "x",
          }),
        }),
      }),
    );
    expect(results[2]?.status).toBe("PASS");
    expect(results[2]?.title).toContain(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
  });

  test("an unknown platform skips with INFO", () => {
    const results = checkConflicts(deps({ platform: "sunos" }));
    expect(results[2]?.status).toBe("INFO");
    expect(results[2]?.title).toContain("sunos");
  });

  test("an unreadable managed-settings file FAILs rather than passing as absent", () => {
    const eacces = new Error("permission denied") as Error & { code: string };
    eacces.code = "EACCES";
    const results = checkConflicts(
      deps({
        readFile: (path) => {
          if (path === "/etc/claude-code/managed-settings.json") {
            throw eacces;
          }
          return undefined;
        },
      }),
    );
    const fail = results[2];
    expect(fail?.status).toBe("FAIL");
    expect(fail?.title).toContain("/etc/claude-code/managed-settings.json");
    expect(fail?.title).toContain("could not be read");
    expect(fail?.fix).toContain("/etc/claude-code/managed-settings.json");
  });

  test("an unreadable user settings file WARNs instead of being skipped", () => {
    const results = checkConflicts(
      deps({
        env: { HOME },
        readFile: (path) => {
          if (path === `${HOME}/.claude/settings.json`) {
            throw new Error("EACCES");
          }
          return undefined;
        },
      }),
    );
    expect(results[1]?.status).toBe("WARN");
    expect(results[1]?.title).toContain("user settings");
    expect(results[1]?.title).toContain("could not be read");
  });
});

describe("checkConflicts: saved claude.ai login", () => {
  test("a saved login is INFO with the expected-warning wording", () => {
    const results = checkConflicts(
      deps({ env: { HOME }, readFile: files({ [`${HOME}/.claude/.credentials.json`]: "{}" }) }),
    );
    expect(results[3]?.status).toBe("INFO");
    expect(results[3]?.title).toContain("a start-up auth warning is expected");
    expect(results[3]?.title).toContain("the router key wins");
  });

  test("no saved login passes", () => {
    const results = checkConflicts(deps({ env: { HOME } }));
    expect(results[3]?.status).toBe("PASS");
  });

  test("on darwin a clean file check is INFO: a Keychain-held login is not visible", () => {
    const results = checkConflicts(deps({ env: { HOME }, platform: "darwin" }));
    expect(results[3]?.status).toBe("INFO");
    expect(results[3]?.title).toContain("Keychain");
  });

  test("on darwin a saved login file is still reported", () => {
    const results = checkConflicts(
      deps({
        env: { HOME },
        platform: "darwin",
        readFile: files({ [`${HOME}/.claude/.credentials.json`]: "{}" }),
      }),
    );
    expect(results[3]?.status).toBe("INFO");
    expect(results[3]?.title).toContain("a start-up auth warning is expected");
  });
});
