import { REDACTED_KEY } from "../../commands/login";
import { type LoadResult, loadConfig } from "../../config/load";
import { configFile, type Env } from "../../config/paths";
import type { Config } from "../../config/schema";
import { scrub } from "../../router/errors";
import type { CheckResult } from "../results";

export interface ConfigCheck {
  readonly results: CheckResult[];
  /** The loaded config for the checks that need it; undefined when unusable. */
  readonly config: Config | undefined;
}

export interface ConfigDeps {
  readonly env: Env;
  /** Defaults to the real loader (real fs, injected env). */
  readonly load?: (env: Env) => LoadResult;
}

/**
 * Check 2: the claudes config exists, is 0600 in a 0700 directory, is owned by
 * the caller and parses — exactly what readConfig enforces before login or a
 * launch will trust it — and the key appears only as its prefix. The loader's
 * messages already carry their own remedies, so they become the fix line.
 */
export function checkConfig(deps: ConfigDeps): ConfigCheck {
  const loaded = (deps.load ?? loadConfig)(deps.env);
  if (!loaded.ok) {
    return {
      results: [{ status: "FAIL", title: "config", fix: loaded.message }],
      config: undefined,
    };
  }
  return {
    results: [
      {
        status: "PASS",
        title: `config ${configFile(loaded.dir)} (key ${REDACTED_KEY}, tiers ${scrub(loaded.config.tiers.opus)} / ${scrub(loaded.config.tiers.sonnet)} / ${scrub(loaded.config.tiers.haiku)})`,
      },
    ],
    config: loaded.config,
  };
}
