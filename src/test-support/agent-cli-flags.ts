import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_FLAGS_PATH = fileURLToPath(new URL("../../.claude/agents/cli-flags.md", import.meta.url));

/**
 * The phrase that introduces the refusal-examples bullet in cli-flags.md.
 * The path above is resolved from this module, never from the cwd, so the
 * guard reads the checkout's own doc however the test runner was invoked.
 */
const ANCHOR = "in every rejection";

/**
 * Reads .claude/agents/cli-flags.md from disk. Called per lookup so a test
 * that edits the file sees its own edit — the doc is the contract under
 * test, not a snapshot.
 */
function cliFlagsDoc(): string {
  return readFileSync(CLI_FLAGS_PATH, "utf8");
}

/** The code spans of a text, in order; an unterminated span ends the scan. */
function codeSpans(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    const close = text.indexOf("`", i + 1);
    if (close === -1) {
      break;
    }
    out.push(text.slice(i + 1, close));
    i = close + 1;
  }
  return out;
}

/**
 * The backtick-quoted refusal examples of cli-flags.md's "Name the flag,
 * never the value" bullet: the code spans of the parenthesised list that
 * follows the anchor phrase "in every rejection". A reworded or reshaped
 * bullet throws here — a missing anchor, a missing or malformed
 * parenthesised list, or a list with no code spans — instead of silently
 * yielding a shorter list for the guard to cover. Deliberately
 * framework-free: it throws instead of calling expect, like its sibling
 * readme-table.ts.
 */
export function cliFlagsRefusalExamples(source = cliFlagsDoc()): string[] {
  const line = source.split("\n").find((candidate) => candidate.includes(ANCHOR));
  if (line === undefined) {
    throw new Error(`cli-flags.md has no "${ANCHOR}" phrase`);
  }
  const open = line.indexOf("(", line.indexOf(ANCHOR) + ANCHOR.length);
  const close = open === -1 ? -1 : line.indexOf(")", open + 1);
  if (open === -1 || close === -1) {
    throw new Error(`cli-flags.md "${ANCHOR}" bullet has no parenthesised example list`);
  }
  const examples = codeSpans(line.slice(open + 1, close));
  if (examples.length === 0) {
    throw new Error(`cli-flags.md "${ANCHOR}" bullet lists no refusal examples`);
  }
  return examples;
}
