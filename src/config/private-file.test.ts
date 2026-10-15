import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors";
import { writePrivateFile } from "./private-file";

describe("writePrivateFile", () => {
  test("the file lands 0600 regardless of the process umask", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudes-privfile-"));
    try {
      const path = join(dir, "payload");
      // This umask would strip the owner's write bit, leaving the created file
      // at 0400; the explicit fchmod on the open fd must win over it.
      const previous = process.umask(0o277);
      try {
        writePrivateFile(path, "body", { noun: "test", remedy: "never happens in tests" });
      } finally {
        process.umask(previous);
      }
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory is created 0700", () => {
    const base = mkdtempSync(join(tmpdir(), "claudes-privfile-"));
    try {
      const nested = join(base, "claudes");
      writePrivateFile(join(nested, "config.json"), "body", {
        noun: "test",
        remedy: "never happens in tests",
      });
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked directory before chmodding its target", () => {
    const base = mkdtempSync(join(tmpdir(), "claudes-privfile-"));
    try {
      const target = join(base, "target");
      mkdirSync(target);
      chmodSync(target, 0o755); // deliberately loose, so a chmod would be visible
      const link = join(base, "link");
      symlinkSync(target, link);
      expect(() =>
        writePrivateFile(join(link, "config.json"), "body", {
          noun: "config",
          remedy: "re-run login",
        }),
      ).toThrow(`${link} is a symbolic link`);
      // The chmod never ran: the target still carries group/other read bits.
      expect(statSync(target).mode & 0o077).not.toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // A foreign-owned directory cannot be created without root, so the uid the
  // check compares against is injected — the same seam readConfig's tests use.
  test("refuses a directory owned by another uid instead of a raw EPERM", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudes-privfile-"));
    try {
      const path = join(dir, "config.json");
      try {
        writePrivateFile(path, "body", {
          noun: "config",
          remedy: 'remove it and re-run "claudes login"',
          getuid: () => 12345,
        });
        throw new Error("expected writePrivateFile to refuse");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as ConfigError).message;
        expect(message).toContain(
          `${dir} is owned by uid ${statSync(dir).uid}, not by you (uid 12345)`,
        );
        expect(message).toContain('remove it and re-run "claudes login"');
      }
      // Refused before any file was created: the directory is empty.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
