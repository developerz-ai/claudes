import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsFile } from "../config/paths";
import {
  launchSettingsPath,
  removeLaunchSettings,
  sweepStaleLaunchSettings,
} from "./settings-file";

/** A pid no kernel will hand out (above every pid_max, below kill()'s range). */
const DEAD_PID = 999_999_999;

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudes-settings-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("launchSettingsPath", () => {
  test("names this launch's settings file by the launcher's own pid", () => {
    expect(launchSettingsPath("/home/u/.config/claudes")).toBe(
      settingsFile("/home/u/.config/claudes", process.pid),
    );
    expect(launchSettingsPath("/home/u/.config/claudes")).toBe(
      `/home/u/.config/claudes/settings.${process.pid}.json`,
    );
  });
});

describe("sweepStaleLaunchSettings", () => {
  test("removes a dead pid's settings file", () => {
    withDir((dir) => {
      const stale = settingsFile(dir, DEAD_PID);
      writeFileSync(stale, "{}\n", "utf8");
      sweepStaleLaunchSettings(dir);
      expect(existsSync(stale)).toBe(false);
    });
  });

  test("removes the fixed settings.json an older build left behind", () => {
    withDir((dir) => {
      const legacy = join(dir, "settings.json");
      writeFileSync(legacy, "{}\n", "utf8");
      sweepStaleLaunchSettings(dir);
      expect(existsSync(legacy)).toBe(false);
    });
  });

  test("never removes a live pid's settings file, and leaves everything else alone", () => {
    withDir((dir) => {
      // A real child process holds the pid for the sweep's liveness probe.
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)"]);
      try {
        expect(holder.pid).toBeDefined();
        const live = settingsFile(dir, holder.pid as number);
        writeFileSync(live, "{}\n", "utf8");
        const config = join(dir, "config.json");
        writeFileSync(config, "{}\n", "utf8");
        const temp = join(dir, "settings.json.tmp-abc123");
        writeFileSync(temp, "{}\n", "utf8");
        sweepStaleLaunchSettings(dir);
        expect(existsSync(live)).toBe(true);
        expect(existsSync(config)).toBe(true);
        expect(existsSync(temp)).toBe(true); // a stranger's file, not ours to judge
      } finally {
        holder.kill("SIGKILL");
      }
    });
  });

  test("tolerates a missing config dir", () => {
    expect(() => sweepStaleLaunchSettings(join(tmpdir(), "claudes-no-such-dir-xyz"))).not.toThrow();
  });

  test("ignores settings-shaped names that are not per-launch files", () => {
    withDir((dir) => {
      for (const name of [
        "settings.json5",
        "settings.abc.json",
        "settings.0.json",
        "settings..json",
      ]) {
        writeFileSync(join(dir, name), "{}\n", "utf8");
      }
      sweepStaleLaunchSettings(dir);
      for (const name of [
        "settings.json5",
        "settings.abc.json",
        "settings.0.json",
        "settings..json",
      ]) {
        expect(existsSync(join(dir, name))).toBe(true);
      }
    });
  });
});

describe("removeLaunchSettings", () => {
  test("removes the file at the path", () => {
    withDir((dir) => {
      const path = join(dir, "settings.4242.json");
      writeFileSync(path, "{}\n", "utf8");
      removeLaunchSettings(path);
      expect(existsSync(path)).toBe(false);
    });
  });

  test("a missing file is fine, not an error", () => {
    withDir((dir) => {
      expect(() => removeLaunchSettings(join(dir, "settings.4242.json"))).not.toThrow();
    });
  });

  test("a path inside a missing dir is fine too", () => {
    expect(() =>
      removeLaunchSettings(join(tmpdir(), "claudes-no-such-dir-xyz", "settings.1.json")),
    ).not.toThrow();
  });
});
