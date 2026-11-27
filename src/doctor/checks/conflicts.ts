import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Env } from "../../config/paths";
import { isStripped } from "../../launch/env";
import type { CheckResult } from "../results";

/**
 * Reads a file's text: undefined when the path is genuinely absent, and THROWS
 * when it exists but cannot be read — an unreadable managed-settings file must
 * never pass for an absent one, since it outranks --settings.
 */
export type ReadText = (path: string) => string | undefined;

export type ListDirectory = (path: string) => readonly string[];

export interface ConflictsDeps {
  readonly env: Env;
  readonly platform: string;
  readonly cwd: string;
  readonly readFile?: ReadText;
  readonly listDirectory?: ListDirectory;
}

/** The settings keys that would fight the generated --settings file, by name. */
const CONFLICTING_SETTINGS_KEYS = ["apiKeyHelper", "forceLoginMethod"] as const;

/** Where Claude Code keeps a claude.ai login on Linux/BSD-style systems. */
const CREDENTIALS_RELATIVE = ".credentials.json";

/** The managed-settings path per platform; undefined where doctor does not know it. */
function managedSettingsPath(platform: string): string | undefined {
  if (platform === "linux") {
    return "/etc/claude-code/managed-settings.json";
  }
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  return undefined;
}

const MAX_SETTINGS_BYTES = 2 ** 20;

/** Bound the actual read as well as the size observed when opening the file. */
export function readSettingsWithinLimit(
  size: number,
  readInto: (buffer: Uint8Array) => number,
): string {
  if (size > MAX_SETTINGS_BYTES) throw new Error("settings file is too large");
  const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readInto(bytes.subarray(offset));
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_SETTINGS_BYTES) throw new Error("settings file is too large");
  return bytes.toString("utf8", 0, offset);
}

/**
 * The real ReadText: ENOENT/ENOTDIR read as absent; any other failure throws,
 * so an existing-but-unreadable file (mode 000, a directory at the path) can
 * never pass for a missing one.
 */
export const defaultReadFile: ReadText = (path) => {
  let fd: number | undefined;
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    fd = descriptor;
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("settings path is not a regular file");
    return readSettingsWithinLimit(stat.size, (bytes) =>
      readSync(descriptor, bytes, 0, bytes.length, null),
    );
  } catch (err) {
    const code = (err as { readonly code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/**
 * Check 4: everything around claudes that could compete for Claude Code's
 * credentials. Names only, never values — a conflicting variable's value is
 * somebody's secret. Presence in the shell is harmless for claudes (the
 * launcher strips it), a plant in user/project/local settings survives the
 * settings merge and is a WARN, and managed settings outrank `--settings`
 * outright, which is a FAIL.
 */
export function checkConflicts(deps: ConflictsDeps): CheckResult[] {
  const readFile = deps.readFile ?? defaultReadFile;
  const userDir = claudeConfigDir(deps.env, deps.cwd);
  return [
    shellEnvResult(deps.env),
    settingsResult(userDir, deps.cwd, readFile),
    ...managedResults(deps.platform, readFile, deps.listDirectory ?? listManagedDirectory),
    claudeLoginResult(userDir, deps.platform, readFile),
  ];
}

/**
 * Claude Code's settings directory: a non-empty CLAUDE_CONFIG_DIR, resolved
 * against the working directory when relative (Claude Code does the same, and
 * so does the launcher's saved-model read), else `~/.claude`.
 */
function claudeConfigDir(env: Env, cwd: string): string | undefined {
  const custom = env.CLAUDE_CONFIG_DIR;
  if (custom !== undefined && custom !== "") return resolve(cwd, custom);
  return env.HOME?.startsWith("/") ? `${env.HOME}/.claude` : undefined;
}

/** Shell env, presence only: claudes strips these; plain `claude` would use them. */
function shellEnvResult(env: Env): CheckResult {
  const names = Object.keys(env)
    .filter((name) => isStripped(name) && (env[name] ?? "") !== "")
    .sort();
  if (names.length === 0) {
    return { status: "PASS", title: "the shell env sets no router-relevant credentials" };
  }
  return {
    status: "INFO",
    title: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} set in the shell — stripped for claudes; affects plain claude`,
  };
}

interface SettingsSource {
  readonly label: string;
  readonly path: string | undefined;
}

/** User, project and local settings, as Claude Code itself orders them. */
function settingsSources(home: string | undefined, cwd: string): SettingsSource[] {
  return [
    { label: "user settings", path: under(home, "settings.json") },
    { label: "project settings", path: `${cwd}/.claude/settings.json` },
    { label: "local settings", path: `${cwd}/.claude/settings.local.json` },
  ];
}

function under(base: string | undefined, relative: string): string | undefined {
  return base === undefined ? undefined : `${base}/${relative}`;
}

function settingsResult(home: string | undefined, cwd: string, readFile: ReadText): CheckResult {
  const warnings: string[] = [];
  for (const source of settingsSources(home, cwd)) {
    if (source.path === undefined) {
      warnings.push("user settings: no home directory, cannot look");
      continue;
    }
    let text: string | undefined;
    try {
      text = readFile(source.path);
    } catch {
      // Exists but unreadable: report it rather than skip it silently.
      warnings.push(`${source.label} (${source.path}) could not be read`);
      continue;
    }
    if (text === undefined) {
      continue; // absent is the normal case
    }
    const conflicts = conflictingKeys(text);
    if (conflicts === undefined) {
      warnings.push(`${source.label} (${source.path}) could not be parsed as JSON`);
      continue;
    }
    if (conflicts.length > 0) {
      warnings.push(`${source.label} (${source.path}) sets ${conflicts.join(", ")}`);
    }
  }
  if (warnings.length > 0) {
    return {
      status: "WARN",
      title: warnings.join("; "),
      fix: "remove those keys from the settings file(s); the settings claudes generates must be the only source",
    };
  }
  return { status: "PASS", title: "user, project and local settings set no conflicting keys" };
}

/**
 * The conflicting key NAMES a settings JSON carries: `env` entries the launcher
 * strips from the shell, plus apiKeyHelper and forceLoginMethod at the top
 * level. Undefined when the text is not a JSON object.
 */
function conflictingKeys(text: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const settings = parsed as Record<string, unknown>;
  const names = new Set<string>();
  const env = settings.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    for (const name of Object.keys(env as Record<string, unknown>)) {
      if (isStripped(name)) {
        names.add(`env.${name}`);
      }
    }
  }
  for (const key of CONFLICTING_SETTINGS_KEYS) {
    if (key in settings) {
      names.add(key);
    }
  }
  return [...names].sort();
}

const listManagedDirectory: ListDirectory = (path) => {
  try {
    return readdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

function managedResults(platform: string, readFile: ReadText, list: ListDirectory): CheckResult[] {
  const path = managedSettingsPath(platform);
  if (path === undefined) {
    return [
      {
        status: "INFO",
        title: `the managed-settings location is not known on ${platform}; skipped`,
      },
    ];
  }
  const results = [managedResult(path, readFile)];
  const directory = join(dirname(path), "managed-settings.d");
  try {
    const paths = list(directory)
      .filter((name) => !name.startsWith(".") && !name.includes("/") && name.endsWith(".json"))
      .sort();
    for (const name of paths) {
      results.push(managedResult(join(directory, name), readFile));
    }
  } catch {
    results.push({
      status: "FAIL",
      title: `managed settings directory ${directory} could not be read`,
      fix: "make the managed settings directory readable",
    });
  }
  return results;
}

function managedResult(path: string, readFile: ReadText): CheckResult {
  let text: string | undefined;
  try {
    text = readFile(path);
  } catch {
    // The path exists but cannot be read (mode 000, a directory there): it
    // still outranks --settings, so hiding it behind "no managed settings"
    // would defeat this check.
    return {
      status: "FAIL",
      title: `managed settings ${path} outrank --settings and exist but could not be read`,
      fix: `make ${path} readable or remove it; it may override the settings claudes generates`,
    };
  }
  if (text === undefined) {
    return { status: "PASS", title: `no managed settings at ${path}` };
  }
  const conflicts = conflictingKeys(text);
  if (conflicts === undefined) {
    return {
      status: "FAIL",
      title: `managed settings ${path} outrank --settings and could not be parsed as JSON`,
      fix: `fix or remove ${path}`,
    };
  }
  if (conflicts.length > 0) {
    return {
      status: "FAIL",
      title: `managed settings ${path} outrank --settings and set ${conflicts.join(", ")}`,
      fix: `remove those keys from ${path}; they override the settings claudes generates`,
    };
  }
  return { status: "PASS", title: `managed settings ${path} set no conflicting keys` };
}

function claudeLoginResult(
  home: string | undefined,
  platform: string,
  readFile: ReadText,
): CheckResult {
  const path = under(home, CREDENTIALS_RELATIVE);
  let present = false;
  if (path !== undefined) {
    try {
      present = readFile(path) !== undefined;
    } catch {
      present = true; // unreadable is not absent: report it
    }
  }
  if (present) {
    return {
      status: "INFO",
      title:
        "a saved claude.ai login exists — a start-up auth warning is expected; the router key wins",
    };
  }
  if (platform === "darwin") {
    // On macOS a claude.ai login lives in the Keychain, which doctor cannot
    // inspect — so a clean file check proves nothing there.
    return {
      status: "INFO",
      title:
        "no saved claude.ai login in ~/.claude/.credentials.json — on macOS a login can also live in the Keychain, which doctor cannot inspect",
    };
  }
  return { status: "PASS", title: "no saved claude.ai login" };
}
