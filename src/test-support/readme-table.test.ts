import { describe, expect, test } from "bun:test";
import { readmeRefusalRows, readmeRouterDownMessage } from "./readme-table";

/**
 * The parser's own contract, checked against the README as it stands. The
 * guards that use the parser (src/readme-refusals.test.ts, src/readme.test.ts)
 * assert the behaviour the table promises; this file asserts that the table
 * is read the way they assume — ten rows, code spans unquoted, the
 * "(message above)" cell resolved and the prose cell left without a message.
 */

const rows = readmeRefusalRows();

describe("README refusals table", () => {
  test("the table has the ten documented rows", () => {
    expect(rows.length).toBe(10);
    expect(rows.map((row) => row.exit)).toEqual([64, 64, 64, 64, 64, 64, 69, 78, 127, 1]);
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

  test("the rerouting row keeps the <name> template", () => {
    const row = rows.find((candidate) => candidate.message?.includes("<name>") === true);
    expect(row).toBeDefined();
    expect(row?.exit).toBe(64);
    expect(row?.message).toBe(
      "claudes: refusing: <name> is set, so this session would not go to the router",
    );
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
