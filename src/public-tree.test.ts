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
 */

/** Hosts on our own domain that a public file may name. */
const PERMITTED_OWN_HOSTS = new Set(["developerz.ai", "www.developerz.ai"]);

/** Any `<name>.developerz.ai` is on our own domain. */
const OWN_HOST = /\b(?:[a-z0-9-]+\.)*developerz\.ai\b/g;

/** The platform's own identifiers: run, plan, task and review-thread ids. */
const INTERNAL_ID = /\b(?:run|rtk|rvo|tsk|PRRT)_[A-Za-z0-9]{12,}\b/g;

/** An env key that names a credential rather than a setting. */
const CREDENTIAL_NAME = /(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)$/;

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

describe("the public tree", () => {
  test("names no internal service on our own domain", () => {
    const files = trackedFiles();
    if (files === null) {
      console.warn("public-tree: git is unavailable; skipping the tracked-tree guard");
      return;
    }
    const offenders: string[] = [];
    for (const path of files) {
      if (isPlatformOwned(path)) continue;
      const text = readText(path);
      if (text === null) continue;
      for (const match of text.matchAll(OWN_HOST)) {
        if (!PERMITTED_OWN_HOSTS.has(match[0])) offenders.push(path);
      }
    }
    expect(
      offenders,
      `a tracked file names an internal host on our own domain (only ${[...PERMITTED_OWN_HOSTS].join(", ")} may be named): ${[...new Set(offenders)].join(", ")}`,
    ).toEqual([]);
  });

  test("carries no internal run, plan, task or review-thread id", () => {
    const files = trackedFiles();
    if (files === null) {
      console.warn("public-tree: git is unavailable; skipping the tracked-tree guard");
      return;
    }
    const offenders: string[] = [];
    for (const path of files) {
      if (isPlatformOwned(path)) continue;
      const text = readText(path);
      if (text === null) continue;
      if (INTERNAL_ID.test(text)) offenders.push(path);
    }
    expect(
      offenders,
      `a tracked file carries an internal identifier: ${[...new Set(offenders)].join(", ")}`,
    ).toEqual([]);
  });

  test("the tracked .mcp.json names no credential and no internal endpoint", () => {
    const text = readText(".mcp.json");
    expect(text).not.toBeNull();
    const config = JSON.parse(text ?? "{}") as {
      mcpServers?: Record<string, { url?: unknown; env?: Record<string, unknown> }>;
    };
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      for (const key of Object.keys(server.env ?? {})) {
        expect(
          CREDENTIAL_NAME.test(key),
          `.mcp.json names a credential (${name}.${key}); a tracked config must never hold one`,
        ).toBe(false);
      }
      if (typeof server.url === "string") {
        for (const match of server.url.matchAll(OWN_HOST)) {
          expect(
            PERMITTED_OWN_HOSTS.has(match[0]),
            `.mcp.json points at an internal service (${name})`,
          ).toBe(true);
        }
      }
    }
  });
});
