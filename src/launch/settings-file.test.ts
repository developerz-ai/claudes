import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSettingsPath, sweepStaleLaunchSettings, writeLaunchSettings } from "./settings-file";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudes-settings-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("launch settings files", () => {
  test("digest and profile distinguish payloads while identical content reuses the inode", () => {
    withDir((dir) => {
      const initial = '{"env":{"HTTPS_PROXY":"http://proxy"}}\n';
      const changed = '{"env":{"HTTPS_PROXY":"http://new-proxy"}}\n';
      const oldPath = launchSettingsPath(dir, "work", initial);
      const newPath = launchSettingsPath(dir, "work", changed);
      expect(oldPath).toMatch(/settings\.work\.[0-9a-f]{16}\.json$/);
      expect(oldPath).not.toBe(newPath);
      expect(oldPath).not.toBe(launchSettingsPath(dir, "personal", initial));
      writeLaunchSettings(oldPath, initial);
      const original = statSync(oldPath);
      writeLaunchSettings(launchSettingsPath(dir, "work", initial), initial);
      expect(statSync(oldPath).ino).toBe(original.ino);
      expect(statSync(oldPath).mode & 0o777).toBe(0o600);
      writeLaunchSettings(newPath, changed);
      expect(readFileSync(oldPath, "utf8")).toBe(initial);
      expect(readFileSync(newPath, "utf8")).toBe(changed);
    });
  });

  test("sweep removes only old, recognized temporary siblings", () => {
    withDir((dir) => {
      const now = Date.now();
      const hour = 60 * 60 * 1000;
      const named = launchSettingsPath(dir, "work", "{}\n");
      const legacy = join(dir, "settings.999999999.json");
      const preserved = [
        named,
        legacy,
        join(dir, "settings.json"),
        join(dir, "foreign.json.tmp-abcd"),
      ];
      const stale = [`${named}.tmp-abcd`, `${legacy}.tmp-abcd`];
      for (const file of [...preserved, ...stale]) {
        writeFileSync(file, "{}\n");
        const old = new Date(now - 60 * 24 * hour);
        utimesSync(file, old, old);
      }
      const recent = `${named}.tmp-recent`;
      writeFileSync(recent, "{}\n");
      const young = new Date(now - 23 * hour);
      utimesSync(recent, young, young);
      const old = new Date(now - 25 * hour);
      utimesSync(stale[0] as string, old, old);
      sweepStaleLaunchSettings(dir, now);
      expect([...preserved, recent].every(existsSync)).toBe(true);
      expect(stale.some(existsSync)).toBe(false);
    });
  });

  test("does not sweep through a symlinked config directory", () => {
    withDir((dir) => {
      const target = join(dir, "target");
      mkdirSync(target, { mode: 0o700 });
      const oldTemp = join(target, "settings.12345.json.tmp-old");
      writeFileSync(oldTemp, "{}\n");
      const old = new Date(0);
      utimesSync(oldTemp, old, old);
      const link = join(dir, "link");
      symlinkSync(target, link);
      sweepStaleLaunchSettings(link);
      expect(existsSync(oldTemp)).toBe(true);
    });
  });
});
