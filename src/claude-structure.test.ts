import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HEADER = "| Path | Purpose |";
const SEPARATOR = "|---|---|";

type Target = { path: string; line: number };

function invalid(line: number, detail: string): never {
  throw new Error(`CLAUDE.md:${line}: Structure table: ${detail}`);
}

function structureTargets(source: string): Target[] {
  const lines = source.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === "## Structure");
  if (heading === -1) invalid(1, "missing ## Structure section");
  let end = heading + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end] ?? "")) end++;
  let cursor = heading + 1;
  while (cursor < end && lines[cursor]?.trim() === "") cursor++;
  if (!/^\|\s*Path\s*\|\s*Purpose\s*\|$/.test(lines[cursor]?.trim() ?? "")) {
    invalid(cursor + 1, "missing or malformed Path / Purpose header");
  }
  cursor++;
  if (!/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(lines[cursor]?.trim() ?? "")) {
    invalid(cursor + 1, "missing or malformed separator");
  }
  cursor++;
  const targets: Target[] = [];
  for (; cursor < end; cursor++) {
    const row = lines[cursor]?.trim() ?? "";
    if (row === "") break;
    // Parse only the first cell: Purpose contains both raw and escaped pipes.
    const match = /^\|\s*`([^`]+)`\s*\|\s*(.+)\|$/.exec(row);
    const path = match?.[1];
    if (
      path === undefined ||
      !/^[\w.-]+(?:\/[\w.-]+)*\/?$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      invalid(cursor + 1, `malformed path row ${JSON.stringify(row)}`);
    }
    targets.push({ path, line: cursor + 1 });
  }
  if (targets.length === 0) invalid(cursor + 1, "empty table");
  return targets;
}

function checkStructure(root: string): Target[] {
  const targets = structureTargets(readFileSync(join(root, "CLAUDE.md"), "utf8"));
  for (const target of targets) {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(join(root, target.path));
    } catch {
      invalid(target.line, `missing or unreadable target \`${target.path}\``);
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      invalid(target.line, `target is not a file or directory: \`${target.path}\``);
    }
    if (target.path.endsWith("/") && !stats.isDirectory()) {
      invalid(target.line, `directory target is not a directory: \`${target.path}\``);
    }
  }
  return targets;
}

function table(...rows: string[]): string {
  return ["## Structure", "", HEADER, SEPARATOR, ...rows, ""].join("\n");
}

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claude-structure-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CLAUDE.md Structure targets", () => {
  test("every documented repository file and directory exists", () => {
    checkStructure(REPO_ROOT);
  });

  test("checks files, directories and dot-directory targets, not Purpose references", () => {
    fixture((root) => {
      writeFileSync(join(root, "module.ts"), "");
      mkdirSync(join(root, ".github"));
      writeFileSync(join(root, ".github", "ci.yml"), "");
      writeFileSync(
        join(root, "CLAUDE.md"),
        table(
          "| `module.ts` | `missing.ts` and `a | b` and escaped \\| pipes |",
          "| `.github/` | directory |",
          "| `.github/ci.yml` | workflow |",
        ),
      );
      expect(checkStructure(root).map((target) => target.path)).toEqual([
        "module.ts",
        ".github/",
        ".github/ci.yml",
      ]);
    });
  });

  for (const operation of ["rename", "delete"] as const) {
    test(`fails with document, line and target after ${operation}`, () => {
      fixture((root) => {
        const target = join(root, "module.ts");
        writeFileSync(target, "");
        writeFileSync(join(root, "CLAUDE.md"), table("| `module.ts` | module |"));
        expect(() => checkStructure(root)).not.toThrow();
        if (operation === "rename") renameSync(target, join(root, "renamed.ts"));
        else rmSync(target);
        expect(() => checkStructure(root)).toThrow(
          "CLAUDE.md:5: Structure table: missing or unreadable target `module.ts`",
        );
      });
    });
  }

  test("scopes parsing to the Structure table, not dependency prose or other sections", () => {
    const source = [
      "## Other",
      "| `missing-before.ts` | ignored |",
      table("| `module.ts` | module |"),
      "Dependency direction: `absent.ts` | `also-absent.ts`",
      "| `missing-in-prose.ts` | ignored |",
      "## Commands",
      "| `missing-after.ts` | ignored |",
    ].join("\n");
    expect(structureTargets(source)).toEqual([{ path: "module.ts", line: 7 }]);
  });

  const malformed = [
    ["missing section", "## Other\n| `module.ts` | module |"],
    ["missing table", "## Structure\n\n## Other\n"],
    ["empty table", table()],
    ["wrong header", table("| `module.ts` | module |").replace("Path", "File")],
    ["bad separator", table("| `module.ts` | module |").replace(SEPARATOR, "|--|--|")],
    ["unquoted path", table("| module.ts | module |")],
    ["empty path", table("| `` | module |")],
    ["unclosed backtick", table("| `module.ts | module |")],
    ["missing closing pipe", table("| `module.ts` | module")],
    ["missing opening pipe", table("`module.ts` | module |")],
    ["absolute path", table("| `/module.ts` | module |")],
    ["escaping path", table("| `../module.ts` | module |")],
    ["bad later row", table("| `module.ts` | module |", "| broken | row |")],
  ];
  for (const [name, source] of malformed) {
    test(`rejects ${name} instead of vacuously passing`, () => {
      expect(() => structureTargets(source ?? "")).toThrow(/CLAUDE\.md:\d+: Structure table:/);
    });
  }
});
