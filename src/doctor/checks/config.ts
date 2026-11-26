import { REDACTED_KEY } from "../../commands/login";
import { type LoadResult, loadConfig } from "../../config/load";
import { type Env, profileFile } from "../../config/paths";
import { DEFAULT_PROFILE } from "../../config/profile";
import type { Config } from "../../config/schema";
import { scrub } from "../../router/errors";
import type { CheckResult } from "../results";

export interface ConfigCheck {
  readonly results: CheckResult[];
  /** The loaded config for the checks that need it; undefined when unusable. */
  readonly config: Config | undefined;
  readonly profile?: string;
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
  const profile = loaded.profile ?? DEFAULT_PROFILE;
  return {
    profile,
    results: [
      {
        status: "PASS",
        title: `config ${profileFile(loaded.dir, profile)} (profile ${profile}, key ${REDACTED_KEY}, tiers ${scrub(loaded.config.tiers.opus)} / ${scrub(loaded.config.tiers.sonnet)} / ${scrub(loaded.config.tiers.haiku)})`,
      },
    ],
    config: loaded.config,
  };
}
