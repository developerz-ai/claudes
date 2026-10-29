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
function section(heading: string, source = readme()): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    throw new Error(`README has no "${heading}" section`);
  }
  return sectionLines(lines, start);
}

/**
 * The lines of the section whose heading matches `pattern`, up to the next
 * heading of the same level. Throws when no heading matches.
 */
function sectionMatching(pattern: RegExp, source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => pattern.test(line.trimEnd()));
  if (start === -1) {
    throw new Error(`README has no section matching ${String(pattern)}`);
  }
  return sectionLines(lines, start);
}

/** The lines below the heading at `start`, up to the next heading of the same level. */
function sectionLines(lines: string[], start: number): string[] {
  const level = (lines[start] ?? "").match(/^#+/)?.[0].length ?? 0;
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

export type KnownGapRow = {
  readonly what: string;
  readonly status: string;
  readonly issue: string;
};

/** All gap cells, including informational rows; markdown is preserved. */
export function readmeKnownGapRows(source = readme()): KnownGapRow[] {
  const heading = "## Known gaps through Claude subscriptions";
  const body = section(heading, source);
  const start = body.findIndex((line) => line.trim().startsWith("|"));
  if (start === -1) {
    throw new Error("README has no known-gaps table");
  }
  const header = cells(body[start] ?? "");
  if (header.join("|") !== "What|Status in a claudes session|Router issue") {
    throw new Error("README known-gaps table has unexpected columns");
  }
  const separator = cells(body[start + 1] ?? "");
  if (separator.length !== 3 || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    throw new Error("README known-gaps table has a malformed separator");
  }
  const rows: KnownGapRow[] = [];
  for (const line of body.slice(start + 2)) {
    if (line.trim() === "") {
      break;
    }
    const parsed = cells(line);
    if (parsed.length !== 3 || parsed.some((cell) => cell === "" || /^:?-+:?$/.test(cell))) {
      throw new Error("README known-gaps row must have 3 non-empty cells");
    }
    rows.push({ what: parsed[0] ?? "", status: parsed[1] ?? "", issue: parsed[2] ?? "" });
  }
  if (rows.length === 0) {
    throw new Error("README known-gaps table has no rows");
  }
  return rows;
}

/** Exact note lines from the network section's single, closed fenced block. */
export function readmeNetworkNotes(source = readme()): string[] {
  const body = section("## Network, proxies and certificates", source);
  const notes: string[] = [];
  let opened = false;
  let closed = false;
  for (const line of body) {
    if (line.startsWith("```")) {
      if (line !== "```" || closed) {
        throw new Error("README network notes have an unexpected fence");
      }
      if (opened) {
        closed = true;
      } else {
        opened = true;
      }
      continue;
    }
    if (opened && !closed) {
      if (!line.startsWith("note: ") || line.trim() === "note:") {
        throw new Error("README network note must be a non-empty note line");
      }
      notes.push(line);
    }
  }
  if (!opened || !closed || notes.length === 0) {
    throw new Error("README network notes need a non-empty, closed fenced block");
  }
  return notes;
}

/** The heading the network section lives under. */
const NETWORK_HEADING = "## Network, proxies and certificates";

/**
 * The heading of the success-path behaviour list. The apostrophe is matched
 * loosely: a typographic quote in the README must not break the parse.
 */
const BEHAVIOUR_HEADING = /^## What it does and doesn.t do$/;

/** The phrase the network section introduces its pinned transport names with. */
const PINNED_ANCHOR = "pins the network-related variables";

/** The phrase the network section introduces its parent-only names with. */
const PARENT_ONLY_ANCHOR = "carried over only when your shell sets them";

/** The phrase the success-path bullet lists the stripped credentials after. */
const STRIPPED_ANCHOR = "the child environment is stripped of";

/** The shape of an env name: letters, digits and underscores. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The shape of an env name, or of a family of them written as a glob. */
const ENV_NAME_OR_FAMILY = /^[A-Za-z_][A-Za-z0-9_*]*$/;

/** A section's lines as one whitespace-normalised paragraph. */
function prose(body: string[]): string {
  return body.join(" ").replace(/\s+/g, " ").trim();
}

/** One sentence of a prose block, with its offsets in that block. */
interface Sentence {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The sentences of a prose block: a "." outside a code span, followed by
 * whitespace or the end of the block, ends one.
 */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  let inSpan = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (char === "`") {
      inSpan = !inSpan;
      continue;
    }
    if (char !== "." || inSpan) {
      continue;
    }
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) {
      continue;
    }
    out.push({ text: text.slice(start, i + 1), start, end: i + 1 });
    start = i + 1;
  }
  const rest = text.slice(start);
  if (rest.trim() !== "") {
    out.push({ text: rest, start, end: text.length });
  }
  return out;
}

/**
 * The sentence holding `anchor`, and where the anchor starts inside it.
 * Throws when the phrase is gone: a reworded README fails loudly here
 * instead of silently yielding a shorter list.
 */
function sentenceAt(text: string, anchor: string): { sentence: string; anchorAt: number } {
  const index = text.indexOf(anchor);
  if (index === -1) {
    throw new Error(`README has no "${anchor}" phrase`);
  }
  const found = sentences(text).find((one) => index >= one.start && index < one.end);
  if (found === undefined) {
    throw new Error(`README's "${anchor}" phrase is not inside a sentence`);
  }
  return { sentence: found.text, anchorAt: index - found.start };
}

/** The code spans of a text, in order; an unterminated span ends the scan. */
function codeSpans(text: string, from = 0): string[] {
  const out: string[] = [];
  let i = from;
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

/** The code spans of the sentence holding `anchor`, after the anchor itself. */
function namesAfterAnchor(text: string, anchor: string): string[] {
  const found = sentenceAt(text, anchor);
  return codeSpans(found.sentence, found.anchorAt + anchor.length);
}

/** The code spans of the whole sentence holding `anchor`. */
function namesOfAnchorSentence(text: string, anchor: string): string[] {
  return codeSpans(sentenceAt(text, anchor).sentence);
}

/** The names of a documented list, each checked for the shape an env name has. */
function envNames(names: string[], shape: RegExp, what: string): string[] {
  if (names.length === 0) {
    throw new Error(`README documents no ${what} env names`);
  }
  for (const name of names) {
    if (!shape.test(name)) {
      throw new Error(
        `README documents a ${what} env name that is not one: ${JSON.stringify(name)}`,
      );
    }
  }
  return names;
}

/**
 * The list items of a section body, each flattened to one paragraph: a
 * line that starts an item opens one, the lines under it belong to it, and
 * a blank line ends it.
 */
function listItems(body: string[]): string[] {
  const items: string[] = [];
  let current: string[] = [];
  for (const line of body) {
    if (/^\s*[-*]\s/.test(line)) {
      if (current.length > 0) {
        items.push(prose(current));
      }
      current = [line];
      continue;
    }
    if (current.length === 0) {
      continue;
    }
    if (line.trim() === "") {
      items.push(prose(current));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    items.push(prose(current));
  }
  return items;
}

/** An env name the README may list: the env-name shape, and an underscore. */
function isEnvName(name: string): boolean {
  return ENV_NAME_OR_FAMILY.test(name) && name.includes("_");
}

/**
 * The transport env names the README's "Network, proxies and certificates"
 * section documents for the generated settings.
 */
export interface ReadmeTransportNames {
  /** Pinned to the shell's own value, or to "": PINNED_TRANSPORT_ENV. */
  readonly pinned: readonly string[];
  /** Carried over only when the shell sets them: PARENT_ONLY_TRANSPORT_ENV. */
  readonly parentOnly: readonly string[];
}

/**
 * The transport env names the README's network section documents, read from
 * its prose by anchor phrase: the names the launcher pins to the shell's own
 * value, and the ones it carries over only when the shell sets them. A
 * README that drops a name yields a shorter list; one that drops the anchor
 * throws instead of quietly returning what is left.
 */
export function readmePinnedTransportNames(source = readme()): ReadmeTransportNames {
  const body = prose(section(NETWORK_HEADING, source));
  return {
    pinned: envNames(namesAfterAnchor(body, PINNED_ANCHOR), ENV_NAME, "pinned transport"),
    parentOnly: envNames(
      namesOfAnchorSentence(body, PARENT_ONLY_ANCHOR),
      ENV_NAME,
      "parent-only transport",
    ),
  };
}

/**
 * The credential names the README's success-path bullet says the child
 * environment is stripped of: every env-shaped name the bullet mentions —
 * the two vars the generated settings pins to "", the credential families,
 * the bare Bedrock token and the provider switch it names. The bullet is
 * located by the anchor phrase, so a reworded anchor throws instead of
 * quietly yielding a shorter list.
 */
export function readmeStrippedCredentialNames(source = readme()): string[] {
  const body = sectionMatching(BEHAVIOUR_HEADING, source);
  const bullet = listItems(body).find((item) => item.includes(STRIPPED_ANCHOR));
  if (bullet === undefined) {
    throw new Error(`README has no "${STRIPPED_ANCHOR}" phrase`);
  }
  const names = codeSpans(bullet).filter(isEnvName);
  return envNames(names, ENV_NAME_OR_FAMILY, "stripped credential");
}
