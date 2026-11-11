import { describe, expect, test } from "bun:test";
import { denyRules, disabledEnv, UNSUPPORTED_FEATURES } from "./unsupported";

describe("unsupported features table", () => {
  test("WebSearch is denied through permissions.deny", () => {
    expect(denyRules()).toEqual(["WebSearch"]);
  });

  test("the advisor is disabled through the env", () => {
    expect(disabledEnv()).toEqual({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });
  });

  test("every row carries a reason and names the tracker that removes it", () => {
    expect(UNSUPPORTED_FEATURES.length).toBeGreaterThan(0);
    for (const row of UNSUPPORTED_FEATURES) {
      expect(row.feature.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.removedBy.kind === "deny" || row.removedBy.kind === "env").toBe(true);
      // A tracker is an open router issue in `owner/repo#number` form, or
      // null: the router has no open issue for the gap, and a closed issue is
      // not a tracker.
      if (row.issue !== null) {
        expect(row.issue).toMatch(/^[^#\s]+\/[^#\s]+#[0-9]+$/);
      }
    }
  });

  test("the two server-tool gaps have no open router issue behind them", () => {
    // multi-ai-router#210, the epic that recorded both, closed on 2026-11-11
    // and nothing else is open for them: the router's SDK path rejects
    // non-custom server tools, and the launcher turns them off either way.
    expect(UNSUPPORTED_FEATURES.map((row) => row.issue)).toEqual([null, null]);
  });
});
