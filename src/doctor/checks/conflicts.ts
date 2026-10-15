import { readFileSync } from "node:fs";
import type { Env } from "../../config/paths";
import { isStripped } from "../../launch/env";
import type { CheckResult } from "../results";

/** Reads a file's text, or undefined when it is missing or unreadable. */
export type ReadText = (path: string) => string | undefined;

export interface ConflictsDeps {
  readonly env: Env;
  readonly platform: string;
  readonly cwd: string;
  readonly readFile?: ReadText;
}

/** The settings keys that would fight the generated --settings file, by name. */
const CONFLICTING_SETTINGS_KEYS = ["apiKeyHelper", "forceLoginMethod"] as const;

/** Where Claude Code keeps a claude.ai login on Linux/BSD-style systems. */
const CREDENTIALS_RELATIVE = ".claude/.credentials.json";

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

const defaultReadFile: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
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
  const home = absoluteHome(deps.env);
  return [
    shellEnvResult(deps.env),
    settingsResult(home, deps.cwd, readFile),
    managedResult(deps.platform, readFile),
    claudeLoginResult(home, readFile),
  ];
}

function absoluteHome(env: Env): string | undefined {
  const home = env.HOME;
  return home?.startsWith("/") ? home : undefined;
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
    { label: "user settings", path: under(home, ".claude/settings.json") },
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
    const text = readFile(source.path);
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

function managedResult(platform: string, readFile: ReadText): CheckResult {
  const path = managedSettingsPath(platform);
  if (path === undefined) {
    return {
      status: "INFO",
      title: `the managed-settings location is not known on ${platform}; skipped`,
    };
  }
  const text = readFile(path);
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

function claudeLoginResult(home: string | undefined, readFile: ReadText): CheckResult {
  const path = under(home, CREDENTIALS_RELATIVE);
  if (path !== undefined && readFile(path) !== undefined) {
    return {
      status: "INFO",
      title:
        "a saved claude.ai login exists — a start-up auth warning is expected; the router key wins",
    };
  }
  return { status: "PASS", title: "no saved claude.ai login" };
}
