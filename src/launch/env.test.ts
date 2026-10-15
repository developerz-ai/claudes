import { describe, expect, test } from "bun:test";
import { buildChildEnv } from "./env";

/**
 * The expected survivors, hardcoded: the developer's own tooling environment
 * must reach the child untouched — including their AWS, Google and Azure
 * credentials, which are inert without a provider switch.
 */
const KEPT = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/dev",
  EDITOR: "vim",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  AWS_PROFILE: "dev",
  AWS_REGION: "eu-west-1",
  AWS_ACCESS_KEY_ID: "AKIADEVELOPER",
  AWS_SECRET_ACCESS_KEY: "dev-secret",
  AWS_SESSION_TOKEN: "dev-session",
  AWS_DEFAULT_REGION: "eu-west-1",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/dev/sa.json",
  AZURE_CLIENT_SECRET: "dev-azure-secret",
  GIT_DIR: "/repo/.git",
  LANG: "C.UTF-8",
} as const;

/**
 * The expected strip set, hardcoded — one real-world name per stripped prefix
 * and every stripped bare name — so this test pins the list itself rather than
 * echoing whatever the module happens to export.
 */
const STRIPPED = [
  // The ANTHROPIC_ namespace, whatever the name.
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  // The claude.ai OAuth namespace, whatever the name.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_EXPIRY",
  // Provider switches: the explicit list, not the whole CLAUDE_CODE_USE_ prefix.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  // The one Bedrock-only credential outside the namespaces above.
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

function parentWithStrippedVars(): Record<string, string> {
  const parent: Record<string, string> = { ...KEPT };
  for (const name of STRIPPED) {
    parent[name] = "leftover";
  }
  return parent;
}

describe("buildChildEnv", () => {
  test("strips exactly the hardcoded strip set and nothing else", () => {
    expect(buildChildEnv(parentWithStrippedVars())).toEqual(KEPT);
  });

  test("keeps the benign CLAUDE_CODE_USE_ toggles", () => {
    const child = buildChildEnv({
      ...KEPT,
      CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
      CLAUDE_CODE_USE_BASH_TOOL: "1",
    });
    expect(child.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe("1");
    expect(child.CLAUDE_CODE_USE_BASH_TOOL).toBe("1");
  });

  test("keeps the developer's cloud credentials the router cannot use", () => {
    const child = buildChildEnv({ ...KEPT });
    for (const name of [
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ] as const) {
      expect(child[name]).toBe(KEPT[name]);
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
