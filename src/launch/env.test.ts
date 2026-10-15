import { describe, expect, test } from "bun:test";
import { buildChildEnv, STRIPPED_ENV_NAMES, STRIPPED_ENV_PREFIXES } from "./env";

const KEPT = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/dev",
  EDITOR: "vim",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  GIT_DIR: "/repo/.git",
  LANG: "C.UTF-8",
} as const;

/** One offending variable per stripped prefix and per stripped name. */
function parentWithStrippedVars(): Record<string, string> {
  const parent: Record<string, string> = { ...KEPT };
  for (const prefix of STRIPPED_ENV_PREFIXES) {
    parent[`${prefix}STUFF`] = "leftover";
  }
  for (const name of STRIPPED_ENV_NAMES) {
    parent[name] = "leftover";
  }
  // The three ways a personal Anthropic credential usually leaks in.
  parent.ANTHROPIC_AUTH_TOKEN = "sk-ant-oauth01-personal";
  parent.ANTHROPIC_API_KEY = "sk-ant-api03-personal";
  parent.CLAUDE_CODE_OAUTH_TOKEN = "claude-ai-oauth-token";
  return parent;
}

describe("buildChildEnv", () => {
  test("strips every prefix and name it defines", () => {
    expect(buildChildEnv(parentWithStrippedVars())).toEqual(KEPT);
  });

  test("strips the real-world credential names, by name", () => {
    const child = buildChildEnv(parentWithStrippedVars());
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AZURE_CLIENT_SECRET",
    ]) {
      expect(name in child).toBe(false);
    }
  });

  test("keeps the developer's environment untouched", () => {
    expect(buildChildEnv({ ...KEPT })).toEqual(KEPT);
  });

  test("never adds a credential, even when the parent has none", () => {
    const child = buildChildEnv({ PATH: "/bin", HOME: "/home/dev" });
    expect(child).toEqual({ PATH: "/bin", HOME: "/home/dev" });
    expect("ANTHROPIC_AUTH_TOKEN" in child).toBe(false);
    expect("ANTHROPIC_API_KEY" in child).toBe(false);
    expect("CLAUDE_CODE_OAUTH_TOKEN" in child).toBe(false);
  });

  test("drops undefined entries instead of passing them on", () => {
    const child = buildChildEnv({ PATH: "/bin", ANTHROPIC_API_KEY: undefined });
    expect(child).toEqual({ PATH: "/bin" });
  });

  test("returns a copy: the child cannot mutate the parent", () => {
    const parent = { ...KEPT };
    const child = buildChildEnv(parent);
    child.PATH = "/changed";
    child.NEW = "x";
    expect(parent.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect("NEW" in parent).toBe(false);
  });
});
