import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
