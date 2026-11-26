import { lstatSync } from "node:fs";
import { configDir, type Env, profileFile } from "./paths";
import { DEFAULT_PROFILE, profileNames, selectProfile } from "./profile";
import type { Config } from "./schema";
import { ConfigError, readConfig } from "./store";

export const MISSING_CONFIG_MESSAGE = "no claudes config: run `claudes login --url <router>`";

export type LoadResult =
  | { readonly ok: true; readonly config: Config; readonly dir: string; readonly profile?: string }
  | { readonly ok: false; readonly exitCode: 78; readonly message: string };

/**
 * Loads the config for a command that needs credentials (the launcher, or
 * `claudes key`). A missing config is reported with MISSING_CONFIG_MESSAGE and
 * exit 78 (EX_CONFIG); a config we refuse to trust keeps the store's own
 * message, so insecure permissions are refused here exactly as they are at
 * login time.
 */
export function loadConfig(env: Env, selected?: string): LoadResult {
  let dir: string;
  try {
    dir = configDir(env);
  } catch {
    return {
      ok: false,
      exitCode: 78,
      message: "cannot locate claudes config: set HOME or XDG_CONFIG_HOME to an absolute path",
    };
  }
  let profile: string;
  try {
    profile = selectProfile(dir, env, selected);
  } catch (error) {
    return {
      ok: false,
      exitCode: 78,
      message: error instanceof Error ? error.message : "could not select a profile",
    };
  }
  const path = profileFile(dir, profile);
  if (!configExists(path)) {
    const names = profileNames(dir);
    if (profile === DEFAULT_PROFILE && names.length === 0) return missing();
    return {
      ok: false,
      exitCode: 78,
      message: `no claudes config for profile ${profile}; available profiles: ${names.join(", ") || "(none)"}`,
    };
  }
  try {
    return { ok: true, config: readConfig(path), dir, profile };
  } catch (err) {
    if (err instanceof ConfigError) {
      return { ok: false, exitCode: 78, message: err.message };
    }
    return { ok: false, exitCode: 78, message: `could not read the config at ${path}` };
  }
}

/** Distinguishes "nothing was saved yet" from "what was saved is unusable". */
function configExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    // Only absence bypasses readConfig; other failures need its refusal diagnostics.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function missing(): LoadResult {
  return { ok: false, exitCode: 78, message: MISSING_CONFIG_MESSAGE };
}
