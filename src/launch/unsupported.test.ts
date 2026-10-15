import { describe, expect, test } from "bun:test";
import { denyRules, disabledEnv, UNSUPPORTED_FEATURES } from "./unsupported";

describe("unsupported features table", () => {
  test("WebSearch is denied through permissions.deny", () => {
    expect(denyRules()).toEqual(["WebSearch"]);
  });

  test("the advisor is disabled through the env", () => {
    expect(disabledEnv()).toEqual({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });
  });

  test("every row carries a reason and names the router issue that removes it", () => {
    expect(UNSUPPORTED_FEATURES.length).toBeGreaterThan(0);
    for (const row of UNSUPPORTED_FEATURES) {
      expect(row.feature.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.removedBy.kind === "deny" || row.removedBy.kind === "env").toBe(true);
      // An owner/repo#N reference, so a row may move to another repository.
      expect(row.issue).toMatch(/^[\w.-]+\/[\w.-]+#\d+$/);
    }
  });
});
