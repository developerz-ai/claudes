import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
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
import { KEY } from "../test-support/fixtures";
import {
  launchSettingsPath,
  removeProfileSettings,
  sweepStaleLaunchSettings,
  writeLaunchSettings,
} from "./settings-file";

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
      const oldPath = launchSettingsPath(dir, "work", initial, KEY);
      const newPath = launchSettingsPath(dir, "work", changed, KEY);
      expect(oldPath).toMatch(/settings\.work\.[0-9a-f]{16}\.json$/);
      expect(oldPath).not.toBe(newPath);
      expect(oldPath).not.toBe(launchSettingsPath(dir, "personal", initial, KEY));
      expect(oldPath).not.toBe(launchSettingsPath(dir, "work", initial, "rotated-key"));
      writeLaunchSettings(oldPath, initial);
      const original = statSync(oldPath);
      writeLaunchSettings(launchSettingsPath(dir, "work", initial, KEY), initial);
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
      const named = launchSettingsPath(dir, "work", "{}\n", KEY);
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

  test("sweep also removes stranded config and active-profile temporaries", () => {
    withDir((dir) => {
      const now = Date.now();
      const old = new Date(now - 25 * 60 * 60 * 1000);
      // A crash between writePrivateFile's temp write and its rename strands
      // these; the config ones hold the router key.
      const stale = [
        join(dir, "config.json.tmp-1a-2b-3c"),
        join(dir, "config.work.json.tmp-1a-2b-3c"),
        join(dir, "active-profile.tmp-1a-2b-3c"),
      ];
      const preserved = [
        join(dir, "config.json"),
        join(dir, "config.work.json"),
        join(dir, "active-profile"),
        join(dir, "config.Bad.json.tmp-1a"),
      ];
      for (const file of [...stale, ...preserved]) {
        writeFileSync(file, "{}\n");
        utimesSync(file, old, old);
      }
      sweepStaleLaunchSettings(dir, now);
      expect(preserved.every(existsSync)).toBe(true);
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

test("a symlink to matching settings is replaced without changing its target", () => {
  withDir((dir) => {
    const target = join(dir, "private-target");
    const payload = "{}\n";
    const path = launchSettingsPath(dir, "work", payload, KEY);
    writeFileSync(target, payload, { mode: 0o600 });
    const before = statSync(target);
    symlinkSync(target, path);
    writeLaunchSettings(path, payload);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(statSync(target).ino).toBe(before.ino);
    expect(readFileSync(target, "utf8")).toBe(payload);
  });
});

test("cleanup preserves filesystem traversal through a symlink followed by dot-dot", () => {
  withDir((dir) => {
    const actualParent = join(dir, "actual");
    const nested = join(actualParent, "nested");
    mkdirSync(nested, { recursive: true });
    const actual = join(actualParent, "claudes");
    const decoy = join(dir, "claudes");
    for (const path of [actual, decoy]) mkdirSync(path, { mode: 0o700 });
    const link = join(dir, "link");
    symlinkSync(nested, link);
    const traversed = `${link}/../claudes`;
    const name = "settings.work.0123456789abcdef.json";
    const temporary = `${name}.tmp-old`;
    for (const directory of [actual, decoy]) {
      writeFileSync(join(directory, name), "{}\n");
      const temp = join(directory, temporary);
      writeFileSync(temp, "{}\n");
      utimesSync(temp, new Date(0), new Date(0));
    }

    sweepStaleLaunchSettings(traversed);
    expect(existsSync(join(actual, temporary))).toBe(false);
    expect(existsSync(join(decoy, temporary))).toBe(true);
    removeProfileSettings(traversed, "work");
    expect(existsSync(join(actual, name))).toBe(false);
    expect(existsSync(join(decoy, name))).toBe(true);
  });
});
