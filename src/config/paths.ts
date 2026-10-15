/**
 * Pure helpers for locating claudes' on-disk config. Every function takes an
 * injected env so tests never touch the real environment.
 */
export type Env = Record<string, string | undefined>;

const CONFIG_DIR_NAME = "claudes";

/**
 * `${XDG_CONFIG_HOME or $HOME/.config}/claudes`. A relative XDG_CONFIG_HOME is
 * ignored: the XDG base-directory spec only defines absolute paths. A relative
 * HOME is ignored for the same reason — a config path relative to wherever the
 * process happens to start is not a config directory.
 */
export function configDir(env: Env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = absolute(xdg) ? xdg : homeConfigBase(env);
  return `${base}/${CONFIG_DIR_NAME}`;
}

function absolute(path: string | undefined): path is string {
  return path !== undefined && path !== "" && path.startsWith("/");
}

function homeConfigBase(env: Env): string {
  const home = env.HOME;
  if (absolute(home)) {
    return `${home}/.config`;
  }
  throw new Error(
    "claudes: cannot find the config directory: set XDG_CONFIG_HOME or HOME to an absolute path",
  );
}

/** The file `claudes login` writes: `${dir}/config.json`. */
export function configFile(dir: string): string {
  return `${dir}/config.json`;
}

/**
 * The per-launch settings file the launcher writes: `${dir}/settings.<pid>.json`.
 * One file per launch (named by the launcher's pid), so the file — which can
 * carry the shell's proxy URL — exists only while its session does.
 */
export function settingsFile(dir: string, pid: number): string {
  return `${dir}/settings.${pid}.json`;
}
