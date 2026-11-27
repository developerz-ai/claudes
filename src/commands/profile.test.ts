import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_CONFIG_MESSAGE } from "../config/load";
import { configDir, profileFile } from "../config/paths";
import { writeConfig } from "../config/store";
import { KEY, ROUTER } from "../test-support/fixtures";
import { runProfile } from "./profile";

let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudes-profile-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function drive(args: readonly string[]): number {
  return runProfile(
    args,
    { HOME: home },
    (line) => out.push(line),
    (line) => err.push(line),
  );
}

describe("runProfile", () => {
  test("use and remove before any login say there is no config, not a permissions problem", () => {
    for (const args of [
      ["use", "work"],
      ["remove", "work"],
    ]) {
      err = [];
      expect(drive(args)).toBe(78);
      expect(err).toEqual([`claudes profile: ${MISSING_CONFIG_MESSAGE}`]);
    }
  });

  test("removing a profile that has no config says so without naming it", () => {
    writeConfig(profileFile(configDir({ HOME: home }), "default"), {
      version: 1,
      baseUrl: ROUTER,
      key: KEY,
      tiers: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5" },
    });
    expect(drive(["remove", "work"])).toBe(78);
    expect(err).toEqual([
      "claudes profile: that profile has no config; run `claudes profile list`",
    ]);
    expect(out).toEqual([]);
  });
});
