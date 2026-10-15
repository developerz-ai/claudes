import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsFile } from "../config/paths";
import { launchSettingsPath, sweepStaleLaunchSettings } from "./settings-file";

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
  test("removes a dead pid's settings file and its stranded temp sibling", () => {
    withDir((dir) => {
      const stale = settingsFile(dir, DEAD_PID);
      writeFileSync(stale, "{}\n", "utf8");
      // What a SIGKILL between the temp-open and the rename of an atomic
      // write leaves behind, under the same dead pid.
      const staleTemp = `${stale}.tmp-m3z1gx-lx2ab1`;
      writeFileSync(staleTemp, "{}\n", "utf8");
      sweepStaleLaunchSettings(dir);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleTemp)).toBe(false);
    });
  });

  test("does not sweep through a symlinked config dir", () => {
    withDir((dir) => {
      // A stow-style link: the settings writer refuses it, so nothing in its
      // target is the launcher's to delete.
      const target = join(dir, "real");
      mkdirSync(target);
      const stale = settingsFile(target, DEAD_PID);
      const legacy = join(target, "settings.json");
      writeFileSync(stale, "{}\n", "utf8");
      writeFileSync(legacy, "{}\n", "utf8");
      const link = join(dir, "link");
      symlinkSync(target, link);
      sweepStaleLaunchSettings(link);
      expect(existsSync(stale)).toBe(true);
      expect(existsSync(legacy)).toBe(true);
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
        const liveTemp = `${live}.tmp-m3z1gx-lx2ab1`;
        writeFileSync(liveTemp, "{}\n", "utf8");
        const config = join(dir, "config.json");
        writeFileSync(config, "{}\n", "utf8");
        const temp = join(dir, "settings.json.tmp-abc123");
        writeFileSync(temp, "{}\n", "utf8");
        sweepStaleLaunchSettings(dir);
        expect(existsSync(live)).toBe(true);
        expect(existsSync(liveTemp)).toBe(true);
        expect(existsSync(config)).toBe(true);
        expect(existsSync(temp)).toBe(true); // a stranger's file, not ours to judge
      } finally {
        holder.kill("SIGKILL");
      }
    });
  });

  test("keeps settings.1.json: the liveness probe's EPERM means pid 1 is alive", () => {
    withDir((dir) => {
      const init = settingsFile(dir, 1);
      writeFileSync(init, "{}\n", "utf8");
      sweepStaleLaunchSettings(dir);
      // For a non-root prober process.kill(1, 0) throws EPERM, which counts
      // as alive; under root pid 1 genuinely exists. Either way: kept.
      expect(existsSync(init)).toBe(true);
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
        "settings.0.json.tmp-abc123",
        "settings.5.json.tmp-",
      ]) {
        writeFileSync(join(dir, name), "{}\n", "utf8");
      }
      sweepStaleLaunchSettings(dir);
      for (const name of [
        "settings.json5",
        "settings.abc.json",
        "settings.0.json",
        "settings..json",
        "settings.0.json.tmp-abc123",
        "settings.5.json.tmp-",
      ]) {
        expect(existsSync(join(dir, name))).toBe(true);
      }
    });
  });
});
