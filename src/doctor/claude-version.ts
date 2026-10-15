/**
 * `claude --version` prints e.g. `2.1.300 (Claude Code)`; only the first
 * major.minor.patch triple is meaningful here.
 */
export interface VersionTriple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * The minimum `claude` version doctor accepts: the version tested in the
 * spike behind issue #4 (the launcher's live verification of the helper-only
 * credential path ran against this line).
 */
export const MIN_CLAUDE_VERSION = "2.1.299";

/** Parses the first `major.minor.patch` triple in `text`; undefined for none. */
export function parseVersionTriple(text: string): VersionTriple | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** True when `version` sorts at or above `minimum` (numeric, per segment). */
export function isAtLeast(version: VersionTriple, minimum: VersionTriple): boolean {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

/** True when `version` meets MIN_CLAUDE_VERSION (the spike's version). */
export function isSupportedClaude(version: VersionTriple): boolean {
  const minimum = parseVersionTriple(MIN_CLAUDE_VERSION);
  return minimum !== undefined && isAtLeast(version, minimum);
}

/**
 * A version string safe to print: short and character-limited, so a hostile or
 * corrupted `claude --version` line can never push arbitrary bytes (or a key)
 * through doctor's output. Same character class the router client allows for
 * the router's own version string.
 */
export function printableVersion(version: VersionTriple): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}
