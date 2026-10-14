/**
 * Pure helpers for locating claudes' on-disk config. Every function takes an
 * injected env so tests never touch the real environment.
 */
export type Env = Record<string, string | undefined>;

const CONFIG_DIR_NAME = "claudes";

/**
 * `${XDG_CONFIG_HOME or $HOME/.config}/claudes`. A relative XDG_CONFIG_HOME is
 * ignored: the XDG base-directory spec only defines absolute paths.
 */
export function configDir(env: Env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" && xdg.startsWith("/") ? xdg : homeConfigBase(env);
  return `${base}/${CONFIG_DIR_NAME}`;
}

function homeConfigBase(env: Env): string {
  const home = env.HOME;
  if (home === undefined || home === "") {
    throw new Error(
      "claudes: cannot find the config directory: neither XDG_CONFIG_HOME nor HOME is set",
    );
  }
  return `${home}/.config`;
}

/** The file `claudes login` writes: `${dir}/config.json`. */
export function configFile(dir: string): string {
  return `${dir}/config.json`;
}

/** Reserved for future per-user settings: `${dir}/settings.json`. */
export function settingsFile(dir: string): string {
  return `${dir}/settings.json`;
}
