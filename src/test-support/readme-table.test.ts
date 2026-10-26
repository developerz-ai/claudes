import { describe, expect, test } from "bun:test";
import {
  readmeKnownGapRows,
  readmeNetworkNotes,
  readmeRefusalRows,
  readmeRouterDownMessage,
} from "./readme-table";

/**
 * The parser's own contract, checked against the README as it stands. The
 * guards that use the parser (src/readme-refusals.test.ts, src/readme.test.ts)
 * assert the behaviour the table promises; this file asserts that the table
 * is read the way they assume — eleven rows, code spans unquoted, the
 * "(message above)" cell resolved and the prose cell left without a message.
 */

const rows = readmeRefusalRows();

describe("README refusals table", () => {
  test("the table has the eleven documented rows", () => {
    expect(rows.length).toBe(11);
    expect(rows.map((row) => row.exit)).toEqual([64, 64, 64, 64, 64, 64, 64, 69, 78, 127, 1]);
  });

  test("the --key row unescapes its backticks", () => {
    const row = rows.find((candidate) => candidate.when.includes("`--key`"));
    expect(row).toBeDefined();
    expect(row?.message).toBe(
      "claudes: --key is not supported — the router key comes from the config written by `claudes login`",
    );
  });

  test("the missing-config row keeps the literal <router>", () => {
    const row = rows.find((candidate) => candidate.exit === 78);
    expect(row?.message).toBe("no claudes config: run `claudes login --url <router>`");
  });

  test("the rerouting rows keep the <name> template", () => {
    // Both env-refusal rows quote the same message with a <name> template:
    // one for the variable refused on any non-empty value, one for the
    // truthy-gated ones. Every row carrying the template must quote it.
    const rerouting = rows.filter((candidate) => candidate.message?.includes("<name>") === true);
    expect(rerouting.length).toBe(2);
    for (const row of rerouting) {
      expect(row.exit).toBe(64);
      expect(row.message).toBe(
        "claudes: refusing: <name> is set, so this session would not go to the router",
      );
    }
  });

  test("the router-down row resolves to the block above the table", () => {
    const row = rows.find((candidate) => candidate.exit === 69);
    expect(row?.message).toBe(readmeRouterDownMessage());
    expect(row?.message).toBe(
      "router unreachable: run `claudes doctor`, or use plain `claude` with your own login (usage won't be attributed)",
    );
  });

  test("the doctor row quotes no message", () => {
    const row = rows.find((candidate) => candidate.exit === 1);
    expect(row).toBeDefined();
    expect(row?.message).toBeUndefined();
  });
});

const gapHeading = "## Known gaps through Claude subscriptions";
const gapHeader = "| What | Status in a claudes session | Router issue |";
const gapSeparator = "| --- | --- | --- |";
const gapRow = "| Feature | Informational: `literal` | None |";
const gapTable = [gapHeading, gapHeader, gapSeparator, gapRow].join("\n");
const networkHeading = "## Network, proxies and certificates";
const note = "note: keep `backticks`, \\`escapes\\` and trailing spaces  ";
const noteBlock = [networkHeading, "```", note, "```"].join("\n");

describe("README known-gaps parser", () => {
  test("retains all eight rows, including the six informational gaps", () => {
    const gaps = readmeKnownGapRows();
    expect(gaps.map((row) => row.what)).toEqual([
      "WebSearch",
      "Advisor tool",
      "PDFs / document blocks",
      "`count_tokens`",
      "`anthropic-beta` header",
      "Request duration",
      "Working directory",
      "Tool-call relay",
    ]);
    expect(gaps.filter((row) => row.status.startsWith("Disabled"))).toHaveLength(2);
    expect(gaps[7]?.issue).toBe("None");
  });

  test("preserves every cell, including code spans and escaped pipes", () => {
    expect(readmeKnownGapRows(gapTable.replace("Feature", "A \\| B"))).toEqual([
      { what: "A \\| B", status: "Informational: `literal`", issue: "None" },
    ]);
  });

  for (const [label, source] of Object.entries({
    "missing heading": gapTable.replace(gapHeading, "## Other"),
    "missing table": gapHeading,
    "wrong header": gapTable.replace("What", "Feature"),
    "extra header cell": gapTable.replace(gapHeader, `${gapHeader} Extra |`),
    "bad separator": gapTable.replace(gapSeparator, "| --- | nope | --- |"),
    "missing separator": gapTable.replace(`${gapSeparator}\n`, ""),
    "empty table": gapTable.replace(gapRow, ""),
    "missing cell": gapTable.replace(gapRow, "| Feature | None |"),
    "extra cell": gapTable.replace(gapRow, "| Feature | Info | None | Extra |"),
    "empty cell": gapTable.replace(gapRow, "| Feature | | None |"),
    "missing closing pipe": gapTable.replace(gapRow, "| Feature | Info | None"),
    "non-table row": gapTable.replace(gapRow, "Feature | Info | None"),
  })) {
    test(`rejects ${label}`, () => {
      expect(() => readmeKnownGapRows(source)).toThrow();
    });
  }
});

describe("README network-note parser", () => {
  test("reads all six real note lines", () => {
    const notes = readmeNetworkNotes();
    expect(notes).toHaveLength(6);
    expect(notes.every((line) => line.startsWith("note: "))).toBe(true);
  });

  test("preserves exact text and backticks without reading adjacent sections", () => {
    expect(readmeNetworkNotes(`${noteBlock}\n## Next\n\`\`\`\nignored`)).toEqual([note]);
  });

  for (const [label, source] of Object.entries({
    "missing heading": noteBlock.replace(networkHeading, "## Other"),
    "missing fence": `${networkHeading}\n${note}`,
    "unclosed fence": [networkHeading, "```", note].join("\n"),
    "empty fence": [networkHeading, "```", "```"].join("\n"),
    "blank note": noteBlock.replace(note, ""),
    "empty note": noteBlock.replace(note, "note: "),
    "non-note text": noteBlock.replace(note, "unquoted prose"),
    "extra fence": `${noteBlock}\n\`\`\``,
  })) {
    test(`rejects ${label}`, () => {
      expect(() => readmeNetworkNotes(source)).toThrow();
    });
  }
});
