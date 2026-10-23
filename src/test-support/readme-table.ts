import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * One row of the README's "Refusals and exit codes" table.
 *
 * `message` is the quoted text the row promises claudes prints: the code
 * span's content with its outer backticks stripped and its escaped backticks
 * (`\``) turned back into single backticks. A prose cell — "(message above)"
 * resolved, or "(the FAIL lines themselves)" — carries no quoted message,
 * so `message` is undefined for it.
 */
export interface RefusalRow {
  readonly exit: number;
  readonly when: string;
  readonly message: string | undefined;
}

const README_PATH = fileURLToPath(new URL("../../README.md", import.meta.url));

/** The heading the refusals table lives under. */
const TABLE_HEADING = "## Refusals and exit codes";

/** The heading the router-unreachable message is quoted under. */
const ROUTER_DOWN_HEADING = "## Router is down";

/** The cell that points at the router-down block instead of quoting it. */
const MESSAGE_ABOVE = "(message above)";

/**
 * Reads README.md from disk. Called per lookup so a test that edits the file
 * sees its own edit — the table is the contract under test, not a snapshot.
 */
function readme(): string {
  return readFileSync(README_PATH, "utf8");
}

/**
 * The lines of the section that starts at `heading`, up to the next heading
 * of the same level. Throws when the heading is missing.
 */
function section(heading: string): string[] {
  const lines = readme().split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    throw new Error(`README has no "${heading}" section`);
  }
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(/^(#+)\s/);
    if (match !== null && (match[1] ?? "").length <= level) {
      break;
    }
    body.push(line);
  }
  return body;
}

/**
 * Splits a markdown table row into its cells. The leading and trailing pipe
 * are dropped, then the remaining text is split on unescaped pipes.
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
 * The message a cell quotes, or undefined when the cell is prose. A code
 * span's outer backticks are stripped and its escaped backticks become single
 * backticks; anything else — including a half-written span with an
 * unescaped inner backtick — is prose and has no quoted message.
 */
function cellMessage(cell: string): string | undefined {
  if (!cell.startsWith("`") || !cell.endsWith("`") || cell.length < 2) {
    return undefined;
  }
  const inner = cell.slice(1, -1);
  // Every backtick left inside the span must be escaped; an unescaped one
  // means the cell is not a single code span.
  if (/(?<!\\)`/.test(inner)) {
    return undefined;
  }
  return inner.replace(/\\`/g, "`");
}

/**
 * The fenced block under "## Router is down": the message the 69 row points
 * at with "(message above)".
 */
export function readmeRouterDownMessage(): string {
  const body = section(ROUTER_DOWN_HEADING);
  const fence: string[] = [];
  let inside = false;
  for (const line of body) {
    if (!inside) {
      if (line.trim() === "```") {
        inside = true;
      }
      continue;
    }
    if (line.trim() === "```") {
      break;
    }
    fence.push(line);
  }
  if (fence.length === 0) {
    throw new Error(`README has no fenced block under "${ROUTER_DOWN_HEADING}"`);
  }
  return fence.join("\n");
}

/**
 * The rows of the README's "Refusals and exit codes" table. A cell reading
 * "(message above)" is resolved to the router-down block, so every row that
 * quotes a message carries it.
 */
export function readmeRefusalRows(): RefusalRow[] {
  const body = section(TABLE_HEADING);
  const rows: RefusalRow[] = [];
  let header: string[] | undefined;
  for (const line of body) {
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const parsed = cells(line);
    if (parsed.length !== 3) {
      throw new Error(`README refusals row does not have 3 cells: ${JSON.stringify(line)}`);
    }
    if (header === undefined) {
      header = parsed;
      if (header[0] !== "Exit" || header[1] !== "When" || header[2] !== "Message") {
        throw new Error(`README refusals table has unexpected columns: ${JSON.stringify(parsed)}`);
      }
      continue;
    }
    // The separator row (| --- | --- | --- |) is not a data row.
    if (parsed.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    const exit = Number(parsed[0]);
    if (!Number.isInteger(exit)) {
      throw new Error(`README refusals row has a non-numeric exit: ${JSON.stringify(parsed[0])}`);
    }
    const raw = parsed[2] ?? "";
    let message = cellMessage(raw);
    if (message === undefined && raw === MESSAGE_ABOVE) {
      message = readmeRouterDownMessage();
    }
    rows.push({ exit, when: parsed[1] ?? "", message });
  }
  if (header === undefined) {
    throw new Error(`README has no refusals table under "${TABLE_HEADING}"`);
  }
  if (rows.length === 0) {
    throw new Error(`README refusals table under "${TABLE_HEADING}" has no rows`);
  }
  return rows;
}
