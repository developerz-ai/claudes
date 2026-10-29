import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isStripped } from "../launch/env";
import { PROVIDER_SWITCHES } from "../launch/provider-switches";
import { PARENT_ONLY_TRANSPORT_ENV, PINNED_TRANSPORT_ENV } from "../launch/settings";
import {
  readmeKnownGapRows,
  readmeNetworkNotes,
  readmePinnedTransportNames,
  readmeRefusalRows,
  readmeRouterDownMessage,
  readmeStrippedCredentialNames,
} from "./readme-table";

/**
 * The parser's own contract, checked against the README as it stands. The
 * guards that use the parser (src/readme-refusals.test.ts, src/readme.test.ts)
 * assert the behaviour the table promises; this file asserts that the table
 * is read the way they assume — twelve rows, code spans unquoted, the
 * "(message above)" cell resolved and the prose cell left without a message.
 */

const rows = readmeRefusalRows();

describe("README refusals table", () => {
  test("the table has the twelve documented rows", () => {
    expect(rows.length).toBe(12);
    expect(rows.map((row) => row.exit)).toEqual([64, 64, 64, 64, 64, 64, 64, 69, 69, 78, 127, 1]);
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
    // Named by its "When" cell, not by its exit code: the table has a second
    // 69 row (the router that answered with an unusable version), and this
    // one must not be picked up by accident.
    const routerDown = "did not answer the pre-launch check";
    const row = rows.find((candidate) => candidate.when.includes(routerDown));
    expect(row).toBeDefined();
    expect(row?.exit).toBe(69);
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

/** A network section whose pinned sentence names no env var at all. */
const pinnedSection = [
  networkHeading,
  "The launcher pins the network-related variables to your shell's own values.",
].join("\n");

/** A network section whose pinned sentence names something that is no env var. */
const pinnedSectionBadName = [
  networkHeading,
  "The launcher pins the network-related variables: `HTTP_PROXY/http_proxy`.",
].join("\n");

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

const readmeSource = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/**
 * The guard the README's network section must satisfy: the env names it
 * documents are exactly the ones the launcher pins. The two lists are
 * compared as sorted arrays, so a name missing on either side fails — the
 * README dropping one and the code gaining one are the same failure. The
 * expected lists are parameters, so a test can mutate the code side too.
 */
function assertPinnedTransportNames(
  source: string,
  pinned: readonly string[] = PINNED_TRANSPORT_ENV,
  parentOnly: readonly string[] = PARENT_ONLY_TRANSPORT_ENV,
): void {
  const documented = readmePinnedTransportNames(source);
  expect([...documented.pinned].sort()).toEqual([...pinned].sort());
  expect([...documented.parentOnly].sort()).toEqual([...parentOnly].sort());
}

/**
 * The guard the README's success-path bullet must satisfy: every credential
 * it says the child environment is stripped of is really stripped, a family
 * it documents as a glob really is a whole family, and the provider switch
 * it names is one the launcher knows.
 */
function assertStrippedCredentialNames(source: string): void {
  const documented = readmeStrippedCredentialNames(source);
  expect(documented.length).toBeGreaterThan(0);
  for (const name of documented) {
    expect(isStripped(name)).toBe(true);
    if (name.endsWith("*")) {
      const prefix = name.slice(0, -1);
      expect(isStripped(prefix)).toBe(true);
      expect(isStripped(`${prefix}ANY_NAME`)).toBe(true);
    }
  }
  const switches = PROVIDER_SWITCHES as readonly string[];
  expect(documented.filter((name) => switches.includes(name)).length).toBeGreaterThan(0);
}

describe("README pinned-transport parser", () => {
  test("the documented names are exactly the launcher's pinned constants", () => {
    assertPinnedTransportNames(readmeSource);
  });

  test("the parser reads both lists out of the prose, not out of a table", () => {
    const names = readmePinnedTransportNames();
    expect(names.pinned.length).toBe(PINNED_TRANSPORT_ENV.length);
    expect(names.parentOnly.length).toBe(PARENT_ONLY_TRANSPORT_ENV.length);
    // The two lists are disjoint: a name carried over only when the shell
    // sets it is not one the launcher pins to "".
    const overlap = names.pinned.filter((name) => names.parentOnly.includes(name));
    expect(overlap).toEqual([]);
  });

  for (const [label, source] of Object.entries({
    "a pinned name dropped": readmeSource.replace(
      "`CLAUDE_CODE_CERT_STORE` and `BUN_CONFIG_VERBOSE_FETCH`",
      "`CLAUDE_CODE_CERT_STORE`",
    ),
    "a pinned name added": readmeSource.replace(
      "`CLAUDE_CODE_CERT_STORE` and `BUN_CONFIG_VERBOSE_FETCH`",
      "`CLAUDE_CODE_CERT_STORE`, `NODE_FUTURE_FLAG` and `BUN_CONFIG_VERBOSE_FETCH`",
    ),
    "a parent-only name dropped": readmeSource.replace(
      "`SSL_CERT_FILE` and `SSL_CERT_DIR` are carried over",
      "`SSL_CERT_FILE` is carried over",
    ),
    "the pinned anchor reworded": readmeSource.replace(
      "pins the network-related variables",
      "pins the network variables",
    ),
    "the parent-only anchor reworded": readmeSource.replace(
      "carried over only when your",
      "carried over only when the",
    ),
    "the network section gone": readmeSource.replace(
      "\n## Network, proxies and certificates\n",
      "\n## Network\n",
    ),
    "a pinned sentence naming no env var": pinnedSection,
    "a pinned name that is not env-shaped": pinnedSectionBadName,
  })) {
    test(`rejects ${label}`, () => {
      expect(() => assertPinnedTransportNames(source)).toThrow();
    });
  }

  test("adding a name to the code fails the guard", () => {
    expect(() =>
      assertPinnedTransportNames(readmeSource, [...PINNED_TRANSPORT_ENV, "NODE_FUTURE_FLAG"]),
    ).toThrow();
    expect(() =>
      assertPinnedTransportNames(readmeSource, PINNED_TRANSPORT_ENV, [
        ...PARENT_ONLY_TRANSPORT_ENV,
        "SSL_CERT_DIR_2",
      ]),
    ).toThrow();
  });
});

describe("README stripped-credential parser", () => {
  test("every documented credential is one the launcher strips", () => {
    assertStrippedCredentialNames(readmeSource);
  });

  test("the two vars the bullet says the settings pin are in the list too", () => {
    // They sit before the anchor phrase in the bullet, so a parser that
    // only read the names after the anchor would leave them unguarded.
    const names = readmeStrippedCredentialNames();
    expect(names).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(names).toContain("ANTHROPIC_API_KEY");
  });

  for (const [label, source] of Object.entries({
    "a credential the launcher does not strip": readmeSource.replace(
      "`AWS_BEARER_TOKEN_BEDROCK`",
      "`AWS_SECRET_ACCESS_KEY`",
    ),
    "the anchor reworded": readmeSource.replace(
      "the child environment is stripped of",
      "the child environment drops",
    ),
    "the behaviour section gone": readmeSource.replace(
      "## What it does and doesn't do",
      "## What it does",
    ),
  })) {
    test(`rejects ${label}`, () => {
      expect(() => assertStrippedCredentialNames(source)).toThrow();
    });
  }
});
