import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function inventory(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return inventory(root, path);
    return entry.isFile() ? [path] : [];
  });
}

function checkStructure(
  root: string,
  source = readFileSync(join(root, "CLAUDE.md"), "utf8"),
): Target[] {
  const targets = structureTargets(source);
  const files = new Set<string>();
  const directories: string[] = [];
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
    if (stats.isDirectory()) directories.push(`${target.path.replace(/\/$/, "")}/`);
    else files.add(target.path);
  }
  for (const path of [...inventory(root, "src"), ...inventory(root, "bin")]) {
    if (!files.has(path) && !directories.some((directory) => path.startsWith(directory))) {
      invalid(1, `unrepresented file \`${path}\`; add an exact file or directory ancestor row`);
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
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "bin"));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CLAUDE.md Structure targets", () => {
  test("every target exists and every src/bin file has Structure coverage", () => {
    checkStructure(REPO_ROOT);
  });

  for (const path of [
    "src/test-support/agent-cli-flags.ts",
    "src/test-support/fixtures.test.ts",
    "src/test-support/readme-table.test.ts",
    "src/agent-cli-flags-refusals.test.ts",
    "src/claude-structure.test.ts",
    "src/docs-index.test.ts",
    "bin/check-bun-versions.test.ts",
    "bin/check.test.ts",
    "bin/setup",
    "bin/setup.test.ts",
  ]) {
    test(`removing the real Structure row for ${path} leaves its file unrepresented`, () => {
      const source = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
      const target = structureTargets(source).find((entry) => entry.path === path);
      expect(target).toBeDefined();
      const withoutRow = source
        .split(/\r?\n/)
        .filter((_, index) => index + 1 !== target?.line)
        .join("\n");
      expect(() => checkStructure(REPO_ROOT, withoutRow)).toThrow(`unrepresented file \`${path}\``);
    });
  }

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

  test("removing a file's coverage fails even though the remaining targets exist", () => {
    fixture((root) => {
      writeFileSync(join(root, "src", "first.ts"), "");
      writeFileSync(join(root, "src", "second.ts"), "");
      const first = "| `src/first.ts` | first |";
      writeFileSync(join(root, "CLAUDE.md"), table(first, "| `src/second.ts` | second |"));
      expect(() => checkStructure(root)).not.toThrow();
      writeFileSync(join(root, "CLAUDE.md"), table(first));
      expect(() => checkStructure(root)).toThrow("unrepresented file `src/second.ts`");
    });
  });

  for (const directory of ["src", "bin"]) {
    test(`rejects an unrepresented nested ${directory} file`, () => {
      fixture((root) => {
        writeFileSync(join(root, "module.ts"), "");
        writeFileSync(join(root, "CLAUDE.md"), table("| `module.ts` | module |"));
        expect(() => checkStructure(root)).not.toThrow();
        mkdirSync(join(root, directory, "nested"));
        writeFileSync(join(root, directory, "nested", "new-file"), "");
        expect(() => checkStructure(root)).toThrow(
          `unrepresented file \`${directory}/nested/new-file\``,
        );
      });
    });
  }

  for (const suffix of ["", "/"]) {
    test(`real directory rows ending in ${JSON.stringify(suffix)} cover nested files`, () => {
      fixture((root) => {
        mkdirSync(join(root, "src", "modules", "nested"), { recursive: true });
        writeFileSync(join(root, "src", "modules", "nested", "module.ts"), "");
        writeFileSync(join(root, "bin", "tool"), "");
        writeFileSync(
          join(root, "CLAUDE.md"),
          table(`| \`src/modules${suffix}\` | modules |`, "| `bin/tool` | tool |"),
        );
        expect(() => checkStructure(root)).not.toThrow();
        mkdirSync(join(root, "src", "modules-extra"));
        writeFileSync(join(root, "src", "modules-extra", "other.ts"), "");
        expect(() => checkStructure(root)).toThrow(
          "unrepresented file `src/modules-extra/other.ts`",
        );
      });
    });
  }

  test("a file row cannot cover a filename prefix collision", () => {
    fixture((root) => {
      writeFileSync(join(root, "bin", "check"), "");
      writeFileSync(join(root, "bin", "check.test.ts"), "");
      writeFileSync(join(root, "CLAUDE.md"), table("| `bin/check` | check |"));
      expect(() => checkStructure(root)).toThrow("unrepresented file `bin/check.test.ts`");
    });
  });

  test("moving a covered file outside its directory requires a map update", () => {
    fixture((root) => {
      mkdirSync(join(root, "src", "covered"));
      const original = join(root, "src", "covered", "module.ts");
      writeFileSync(original, "");
      writeFileSync(join(root, "CLAUDE.md"), table("| `src/covered/` | modules |"));
      expect(() => checkStructure(root)).not.toThrow();
      renameSync(original, join(root, "src", "moved.ts"));
      expect(() => checkStructure(root)).toThrow("unrepresented file `src/moved.ts`");
    });
  });

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
