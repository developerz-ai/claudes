import { statSync } from "node:fs";
import { configDir, configFile, type Env } from "./paths";
import type { Config } from "./schema";
import { ConfigError, readConfig } from "./store";

export const MISSING_CONFIG_MESSAGE = "no claudes config: run `claudes login --url <router>`";

export type LoadResult =
  | { readonly ok: true; readonly config: Config; readonly dir: string }
  | { readonly ok: false; readonly exitCode: 78; readonly message: string };

/**
 * Loads the config for a command that needs credentials (the launcher, or
 * `claudes key`). A missing config is reported with MISSING_CONFIG_MESSAGE and
 * exit 78 (EX_CONFIG); a config we refuse to trust keeps the store's own
 * message, so insecure permissions are refused here exactly as they are at
 * login time.
 */
export function loadConfig(env: Env): LoadResult {
  let dir: string;
  try {
    dir = configDir(env);
  } catch {
    // No usable HOME or XDG_CONFIG_HOME: there is no config to find.
    return missing();
  }
  const path = configFile(dir);
  if (!configExists(path)) {
    return missing();
  }
  try {
    return { ok: true, config: readConfig(path), dir };
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
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function missing(): LoadResult {
  return { ok: false, exitCode: 78, message: MISSING_CONFIG_MESSAGE };
}
