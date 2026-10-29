import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guard for the docs index (docs/README.md).
 *
 * WHY: every row of the index used to carry a `*(not created yet)*` marker.
 * That made the index a promise about the filesystem — a promise the first
 * page written broke, and a promise nobody had to keep. A row names a
 * location and what belongs there; no cell may claim that a tree is absent.
 *
 * The guard reads the index's TEXT and never stats a directory: a location is
 * a name, not a promise, so the check that reads the index must not turn it
 * back into one. The row count is not pinned either — `/planx` adds a row per
 * plan page, and an index that grows is an index that works.
 */

const INDEX_PATH = fileURLToPath(new URL("../docs/README.md", import.meta.url));

/** The locations the index must name, exactly once each. */
const INDEXED_LOCATIONS = ["docs/idea/", "docs/standards/", "docs/plans/"];

/**
 * The phrases an index may not carry: each one claims that a tree is
 * absent, which is the rot this guard exists to stop. `empty` and `pending`
 * are not claims — they are ordinary words a plan slug may hold.
 */
const EXISTENCE_CLAIMS = [
  "not created yet",
  "not yet created",
  "does not exist",
  "not present",
  "placeholder",
];

/**
 * The first claim a text carries, or undefined when it carries none.
 *
 * WHY: a raw substring match refuses a plan slug that merely holds a claim
 * word (`docs/plans/2026/10/29/101-empty-state/`). The word boundaries keep
 * the guard on the claim itself, not on any word that rhymes with it.
 */
function findClaim(text: string): string | undefined {
  for (const claim of EXISTENCE_CLAIMS) {
    if (new RegExp(`\\b${claim}\\b`, "i").test(text)) {
      return claim;
    }
  }
  return undefined;
}

/** The marker the old index carried on every row; it may not appear at all. */
const ABSENT_MARKER = "not created yet";

/** One row of the index table, with the line it came from. */
interface IndexRow {
  readonly cells: readonly string[];
  readonly line: number;
}

/** The index table: its header row and the data rows under it. */
interface IndexTable {
  readonly header: readonly string[];
  readonly rows: readonly IndexRow[];
}

/**
 * Splits a markdown table row into its cells: the outer pipes are dropped and
 * the rest is split on unescaped pipes, so a cell may hold an escaped one.
 */
function cells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    throw new Error(`not a table row: ${JSON.stringify(line)}`);
  }
  const inner = trimmed.slice(1, -1);
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i] ?? "";
    if (char === "\\" && inner[i + 1] === "|") {
      current += "\\|";
      i++;
      continue;
    }
    if (char === "|") {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

/**
 * The first table in the index: a header row, a separator row, and the data
 * rows under it. The table ends at the first line that is not a row, so the
 * prose after it is not part of the index.
 */
function firstTable(source: string): IndexTable {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith("|"));
  if (start === -1) {
    throw new Error("docs/README.md: the index has no table");
  }
  const header = cells(lines[start] ?? "");
  const separatorLine = lines[start + 1] ?? "";
  if (!separatorLine.trim().startsWith("|")) {
    throw new Error(`docs/README.md:${start + 2}: the index table has no separator row`);
  }
  const separator = cells(separatorLine);
  if (separator.length !== header.length) {
    throw new Error(`docs/README.md:${start + 2}: the index table separator is malformed`);
  }
  for (const cell of separator) {
    if (!/^:?-{3,}:?$/.test(cell)) {
      throw new Error(`docs/README.md:${start + 2}: the index table separator is malformed`);
    }
  }
  const rows: IndexRow[] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      break;
    }
    rows.push({ cells: cells(line), line: i + 1 });
  }
  if (rows.length === 0) {
    throw new Error("docs/README.md: the index table has no rows");
  }
  return { header, rows };
}

/**
 * The path a Where cell names, or undefined when the cell is not a single
 * backticked path. Prose, a parenthetical or a second code span all fail: the
 * cell names a location and nothing else.
 */
function singleBacktickedPath(cell: string): string | undefined {
  const match = /^`([^`]+)`$/.exec(cell);
  if (match === null) {
    return undefined;
  }
  const path = match[1] ?? "";
  if (!/^[\w.-]+(?:\/[\w.-]+)*\/?$/.test(path)) {
    return undefined;
  }
  if (path.split("/").some((part) => part === "." || part === "..")) {
    return undefined;
  }
  return path;
}

/**
 * Checks the index's text and returns the table it holds. Throws on the first
 * defect, naming the line so a maintainer can see which row to fix.
 */
function checkIndex(source: string): IndexTable {
  const table = firstTable(source);
  if (table.header[0] !== "Where") {
    throw new Error("docs/README.md: the index table's first column is not Where");
  }
  const counts = new Map<string, number>();
  for (const row of table.rows) {
    if (row.cells.length !== 2) {
      throw new Error(`docs/README.md:${row.line}: an index row does not have 2 cells`);
    }
    const where = row.cells[0] ?? "";
    const path = singleBacktickedPath(where);
    if (path === undefined) {
      throw new Error(
        `docs/README.md:${row.line}: the Where cell is not a single backticked path: ${JSON.stringify(where)}`,
      );
    }
    for (const cell of row.cells) {
      const claim = findClaim(cell);
      if (claim !== undefined) {
        throw new Error(
          `docs/README.md:${row.line}: an index row claims a tree's existence: ${JSON.stringify(claim)}`,
        );
      }
    }
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  for (const location of INDEXED_LOCATIONS) {
    const count = counts.get(location) ?? 0;
    if (count === 0) {
      throw new Error(`docs/README.md: the index does not name ${location}`);
    }
    if (count > 1) {
      throw new Error(`docs/README.md: the index names ${location} ${count} times`);
    }
  }
  if (source.toLowerCase().includes(ABSENT_MARKER)) {
    throw new Error(`docs/README.md: the index still carries "${ABSENT_MARKER}"`);
  }
  // Every line, not only the table's cells: prose may claim an absent tree too.
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const claim = findClaim(lines[i] ?? "");
    if (claim !== undefined) {
      throw new Error(
        `docs/README.md:${i + 1}: the index claims a tree's existence: ${JSON.stringify(claim)}`,
      );
    }
  }
  return table;
}

/** An index that passes: the three locations, and no claim of absence. */
const CLEAN_FIXTURE = [
  "| Where | What lives there |",
  "|---|---|",
  "| `docs/idea/` | The product idea. |",
  "| `docs/standards/` | The rules. |",
  "| `docs/plans/` | The committed plans. |",
].join("\n");

describe("docs/README.md index", () => {
  test("names the three locations and claims no absence", () => {
    const table = checkIndex(readFileSync(INDEX_PATH, "utf8"));
    const paths = table.rows.map((row) => singleBacktickedPath(row.cells[0] ?? ""));
    for (const location of INDEXED_LOCATIONS) {
      expect(paths).toContain(location);
    }
  });

  test("reads text only: locations that are not on disk pass", () => {
    expect(() => checkIndex(CLEAN_FIXTURE)).not.toThrow();
  });

  test("rejects a row claiming a tree was not created", () => {
    const claimed = CLEAN_FIXTURE.replace(
      "| `docs/idea/` | The product idea. |",
      "| `docs/idea/` | The product idea. *(not created yet)* |",
    );
    expect(() => checkIndex(claimed)).toThrow(/claims a tree's existence/);
  });

  test("rejects the index as it was: rows claiming an uncreated tree", () => {
    const before = [
      "| Where | What lives there |",
      "|---|---|",
      "| `idea/` | Why this repository is shaped the way it is. *(not created yet)* |",
      "| `standards/` | How work is done here. *(not created yet)* |",
      "| `plans/` | The committed outputs of `/planx`. *(not created yet)* |",
    ].join("\n");
    expect(() => checkIndex(before)).toThrow(/claims a tree's existence/);
  });

  test("rejects a Where cell that is not a single backticked path", () => {
    const offenders = [
      "docs/idea/",
      "`docs/idea/` (soon)",
      "`docs/idea/` `docs/plans/`",
      "`docs/idea/*`",
      "`docs/./idea/`",
    ];
    for (const where of offenders) {
      const row = CLEAN_FIXTURE.replace("| `docs/idea/` |", `| ${where} |`);
      expect(() => checkIndex(row)).toThrow(/not a single backticked path/);
    }
  });

  test("rejects an index that drops one of the three locations", () => {
    const dropped = CLEAN_FIXTURE.replace("| `docs/standards/` | The rules. |\n", "");
    expect(() => checkIndex(dropped)).toThrow(/does not name docs\/standards\//);
  });

  test("rejects a location indexed twice", () => {
    const twice = `${CLEAN_FIXTURE}\n| \`docs/plans/\` | The committed plans again. |`;
    expect(() => checkIndex(twice)).toThrow(/names docs\/plans\/ 2 times/);
  });

  test("rejects the absent marker anywhere in the file", () => {
    const stray = `${CLEAN_FIXTURE}\n\nThe idea tree is not created yet.\n`;
    expect(() => checkIndex(stray)).toThrow(/still carries "not created yet"/);
  });

  test("accepts extra rows: the row count is not pinned", () => {
    const extra = `${CLEAN_FIXTURE}\n| \`docs/plans/2026/10/29/101-slug/\` | One plan. |`;
    expect(() => checkIndex(extra)).not.toThrow();
  });

  test("accepts a plan path whose slug holds a claim word", () => {
    const slug = `${CLEAN_FIXTURE}\n| \`docs/plans/2026/10/29/101-empty-state/\` | One plan. |`;
    expect(() => checkIndex(slug)).not.toThrow();
  });

  test("matches a claim on word boundaries, not on a substring", () => {
    const near = CLEAN_FIXTURE.replace(
      "| `docs/idea/` | The product idea. |",
      "| `docs/idea/` | The product idea, not presentation material. |",
    );
    expect(() => checkIndex(near)).not.toThrow();
  });

  test("rejects a claim in prose outside the table", () => {
    const prose = `${CLEAN_FIXTURE}\n\nThe idea tree does not exist.\n`;
    expect(() => checkIndex(prose)).toThrow(/the index claims a tree's existence/);
  });

  test("rejects an index with no table", () => {
    expect(() => checkIndex("A paragraph with no table.\n")).toThrow(/the index has no table/);
  });

  test("rejects a table with no separator row", () => {
    const noSeparator = ["| Where | What lives there |", "The table stops here."].join("\n");
    expect(() => checkIndex(noSeparator)).toThrow(/no separator row/);
  });

  test("rejects a separator row with the wrong number of columns", () => {
    const shortSeparator = ["| Where | What lives there |", "|---|"].join("\n");
    expect(() => checkIndex(shortSeparator)).toThrow(/separator is malformed/);
  });

  test("rejects a separator row that is not dashes", () => {
    const badSeparator = ["| Where | What lives there |", "|--|--|"].join("\n");
    expect(() => checkIndex(badSeparator)).toThrow(/separator is malformed/);
  });

  test("rejects a table with no rows", () => {
    const noRows = ["| Where | What lives there |", "|---|---|", "Nothing follows."].join("\n");
    expect(() => checkIndex(noRows)).toThrow(/the index table has no rows/);
  });

  test("rejects a table whose first column is not Where", () => {
    const renamed = CLEAN_FIXTURE.replace("| Where |", "| Place |");
    expect(() => checkIndex(renamed)).toThrow(/first column is not Where/);
  });

  test("rejects a row that does not have 2 cells", () => {
    const wide = CLEAN_FIXTURE.replace(
      "| `docs/idea/` | The product idea. |",
      "| `docs/idea/` | The product idea. | Extra. |",
    );
    expect(() => checkIndex(wide)).toThrow(/does not have 2 cells/);
  });
});
