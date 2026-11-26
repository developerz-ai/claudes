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

/** Named profiles share the private config directory with the legacy file. */
export function profileFile(dir: string, name: string): string {
  return name === "default" ? configFile(dir) : `${dir}/config.${name}.json`;
}

export function activeProfileFile(dir: string): string {
  return `${dir}/active-profile`;
}

/** Settings files are scoped to a profile and a digest of their contents. */
export function settingsFile(dir: string, profile: string, digest: string): string {
  return `${dir}/settings.${profile}.${digest}.json`;
}
