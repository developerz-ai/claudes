import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * This repository is public, so every tracked file is a public document. Two
 * rules follow from that, and this file is the guard that holds them.
 *
 * 1. No tracked file names an internal service on our own domain. Only the
 *    public hosts below may be written down; anything else — the MCP gateway,
 *    the database gateway, the console — is where our side of the wall lives,
 *    and a reader learns it from a file we chose to publish.
 * 2. No tracked file carries one of the platform's own identifiers: a run, a
 *    plan, a task or a review thread. The id is ours; the thing it points at
 *    is ours.
 *
 * A guard that printed the value it refused would republish it in the CI log
 * and in the review thread, so every message below names the FILE and the
 * kind of value, never the value.
 *
 * The rules are functions, and the last describe block proves each of them
 * against the shapes they exist to catch: a guard that cannot fail is not a
 * guard, so the machinery is pinned here, not only in the tree.
 */

/** Hosts on our own domain that a public file may name. */
const PERMITTED_OWN_HOSTS = new Set(["developerz.ai", "www.developerz.ai"]);

/**
 * Any `<name>.developerz.ai` is on our own domain. The `g` flag is required by
 * `matchAll`, which reads the flag but never advances this regex's own
 * `lastIndex` — so a matchAll loop over many files stays stateless.
 */
const OWN_HOST = /\b(?:[a-z0-9-]+\.)*developerz\.ai\b/g;

/**
 * The platform's own identifiers: run, plan, task and review-thread ids.
 * No `g` flag: this one is used with `test()`, and a global regex keeps its
 * `lastIndex` between calls — so one match would leave the offset pointing
 * into the next file, and a later file whose id sits before that offset would
 * be passed in silence. The guard must not be able to pass by accident.
 */
const INTERNAL_ID = /\b(?:run|rtk|rvo|tsk|PRRT)_[A-Za-z0-9]{12,}\b/;

/**
 * The settings the tracked config may carry: the public tools' own, and
 * nothing else. An allowlist, so a name that would describe one of our
 * services cannot slip in by being added here without a review of this file.
 */
const PERMITTED_ENV_KEYS = new Set([
  "DO_NOT_TRACK",
  "CODEGRAPH_TELEMETRY",
  "CODEGRAPH_NO_UPDATE_CHECK",
]);

/**
 * No tracked server may carry a header today. A public server that needs one
 * adds it here deliberately, with the same review as any other change.
 */
const PERMITTED_HEADER_KEYS = new Set<string>();

/**
 * A tracked config may not reference one of our own variables at all, in any
 * field. A `${...}` placeholder is how a tracked file names a thing it does
 * not write down — a credential, a host — so it is the shape the rule exists
 * to stop.
 */
const VARIABLE_REFERENCE = /\$\{[^}]*\}/;

/** One refusal: the file, and the kind of value — never the value. */
type Offender = { path: string; rule: string };

function hostOffenders(path: string, text: string): Offender[] {
  const offenders: Offender[] = [];
  for (const match of text.matchAll(OWN_HOST)) {
    if (!PERMITTED_OWN_HOSTS.has(match[0])) {
      offenders.push({ path, rule: "names an internal host on our own domain" });
    }
  }
  return offenders;
}

function idOffenders(path: string, text: string): Offender[] {
  return INTERNAL_ID.test(text) ? [{ path, rule: "carries an internal identifier" }] : [];
}

type ServerEntry = { url?: unknown; env?: unknown; headers?: unknown };

function configOffenders(path: string, text: string): Offender[] {
  const offenders: Offender[] = [];
  let config: { mcpServers?: Record<string, ServerEntry> };
  try {
    config = JSON.parse(text) as { mcpServers?: Record<string, ServerEntry> };
  } catch {
    return [{ path, rule: "is not valid JSON" }];
  }
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    // Every field of the entry is scanned for a reference to one of our own
    // variables — the url is a field too, and a url that resolves from the
    // environment names an internal service just as plainly as one that
    // spells it out.
    for (const [field, value] of Object.entries(server)) {
      if (field === "env" || field === "headers") continue;
      if (typeof value === "string" && VARIABLE_REFERENCE.test(value)) {
        offenders.push({ path, rule: `references one of our own variables (${name}.${field})` });
      }
    }
    for (const [key, value] of Object.entries((server.env ?? {}) as Record<string, unknown>)) {
      if (!PERMITTED_ENV_KEYS.has(key)) {
        offenders.push({
          path,
          rule: `names a setting that is not one of the public tools' own (${name})`,
        });
      }
      if (typeof value === "string" && VARIABLE_REFERENCE.test(value)) {
        offenders.push({ path, rule: `references one of our own variables (${name})` });
      }
    }
    for (const [key, value] of Object.entries((server.headers ?? {}) as Record<string, unknown>)) {
      if (!PERMITTED_HEADER_KEYS.has(key)) {
        offenders.push({ path, rule: `carries a header the tracked config may not (${name})` });
      }
      if (typeof value === "string" && VARIABLE_REFERENCE.test(value)) {
        offenders.push({ path, rule: `references one of our own variables (${name})` });
      }
    }
    if (typeof server.url === "string") {
      for (const match of server.url.matchAll(OWN_HOST)) {
        if (!PERMITTED_OWN_HOSTS.has(match[0])) {
          offenders.push({ path, rule: `points at an internal service (${name})` });
        }
      }
    }
  }
  return offenders;
}

/** True when the rules reported a refusal of this kind. */
function reported(offenders: Offender[], kind: string): boolean {
  return offenders.some((offender) => offender.rule.includes(kind));
}

/**
 * `.dz/` is the platform's own working directory: the maintainer agent writes
 * those files, and the onboarding scorecard is rewritten whole on every run. A
 * guard that covered them would fail the platform's own commits rather than a
 * change made here, so they are out of scope — and their content is the
 * platform's business, not this repository's.
 */
function isPlatformOwned(path: string): boolean {
  return path.startsWith(".dz/");
}

function trackedFiles(): string[] | null {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

/** A file we cannot read as text carries no string for a reader to find. */
function readText(path: string): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(REPO_ROOT, path));
  } catch {
    return null;
  }
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function treeOffenders(): Offender[] {
  const files = trackedFiles();
  if (files === null) return [];
  const offenders: Offender[] = [];
  for (const path of files) {
    if (isPlatformOwned(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    offenders.push(...hostOffenders(path, text));
    offenders.push(...idOffenders(path, text));
    if (path === ".mcp.json") offenders.push(...configOffenders(path, text));
  }
  return offenders;
}

describe("the public tree", () => {
  test("names no internal service, carries no internal id, and holds no credential", () => {
    const files = trackedFiles();
    if (files === null) {
      console.warn("public-tree: git is unavailable; skipping the tracked-tree guard");
      return;
    }
    const offenders = treeOffenders();
    expect(
      offenders.map((offender) => `${offender.path}: ${offender.rule}`),
      "a tracked file carries something of ours",
    ).toEqual([]);
  });
});

describe("the guard itself", () => {
  // The fixtures are assembled from parts on purpose: a guard must not put the
  // very values it refuses into the tree it guards. Written out in full, this
  // file would trip the guard on itself.
  const internalHost = ["mcp", "developerz", "ai"].join(".");
  const internalId = `run_${"b".repeat(32)}`;
  // A reference to one of our own variables, written the way a tracked config
  // writes it — assembled from parts, because the literal form is a lint
  // error of its own.
  const reference = (name: string): string => `\${${name}}`;

  test("the identifier matcher is stateless", () => {
    // A global regex would keep its lastIndex between calls, so the second
    // file's identifier — sitting before that stale offset — would be passed
    // in silence. The matcher must leave no trace behind it.
    expect(idOffenders("first.md", internalId)).toHaveLength(1);
    expect(INTERNAL_ID.lastIndex).toBe(0);
    expect(idOffenders("second.md", `${internalId} and some more text after it`)).toHaveLength(1);
    expect(INTERNAL_ID.lastIndex).toBe(0);
  });

  test("every shape the rules exist to catch is caught", () => {
    const withInternalHost = hostOffenders("a.md", `https://${internalHost}/v1/mcp`);
    expect(withInternalHost).toHaveLength(1);
    expect(hostOffenders("a.md", "https://developerz.ai/docs")).toHaveLength(0);

    const withInternalId = idOffenders("a.md", internalId);
    expect(withInternalId).toHaveLength(1);
    expect(idOffenders("a.md", `the ${internalId} id`)).toHaveLength(1);
    expect(idOffenders("a.md", "run_short")).toHaveLength(0);

    // The entry this pull request removes: its URL and its credential header.
    const oldEntry = JSON.stringify({
      mcpServers: {
        internal: {
          type: "http",
          url: `https://${internalHost}/v1/mcp`,
          headers: { Authorization: `Bearer ${reference("EXAMPLE_API_KEY")}` },
        },
      },
    });
    const oldEntryOffenders = configOffenders(".mcp.json", oldEntry);
    expect(reported(oldEntryOffenders, "internal service")).toBe(true);
    expect(reported(oldEntryOffenders, "header")).toBe(true);

    // A header on its own, so the header rule is proved on its own.
    const headerOnly = JSON.stringify({
      mcpServers: {
        "public-tool": {
          type: "stdio",
          command: "bunx",
          headers: { Authorization: `Bearer ${reference("EXAMPLE_API_KEY")}` },
        },
      },
    });
    expect(reported(configOffenders(".mcp.json", headerOnly), "header")).toBe(true);

    // The error tracker's credential names, and its host.
    const oldErrorTracker = JSON.stringify({
      mcpServers: {
        "sentry-mcp": {
          type: "stdio",
          command: "bunx",
          args: ["@sentry/mcp-server@0.42.0"],
          env: {
            EXAMPLE_TOKEN: reference("EXAMPLE_TOKEN"),
            EXAMPLE_HOST: reference("EXAMPLE_HOST"),
          },
        },
      },
    });
    const errorTrackerOffenders = configOffenders(".mcp.json", oldErrorTracker);
    expect(reported(errorTrackerOffenders, "public tools' own")).toBe(true);
    expect(reported(errorTrackerOffenders, "our own variables")).toBe(true);

    // An allowed key whose value still resolves one of our own variables.
    const allowedKeyWithReference = JSON.stringify({
      mcpServers: {
        codegraph: {
          type: "stdio",
          command: "codegraph",
          env: { DO_NOT_TRACK: reference("EXAMPLE_VAR") },
        },
      },
    });
    expect(
      reported(configOffenders(".mcp.json", allowedKeyWithReference), "our own variables"),
    ).toBe(true);

    // A URL that resolves an internal service from the environment.
    const resolvedUrl = JSON.stringify({
      mcpServers: {
        internal: { type: "http", url: reference("EXAMPLE_MCP_URL") },
      },
    });
    expect(reported(configOffenders(".mcp.json", resolvedUrl), "our own variables")).toBe(true);

    // The public tools, as the tracked config holds them today.
    const publicTools = JSON.stringify({
      mcpServers: {
        "sentry-mcp": { type: "stdio", command: "bunx", args: ["@sentry/mcp-server@0.42.0"] },
        codegraph: {
          type: "stdio",
          command: "codegraph",
          args: ["serve", "--mcp"],
          env: { DO_NOT_TRACK: "1", CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" },
        },
      },
    });
    expect(configOffenders(".mcp.json", publicTools)).toEqual([]);
  });
});
