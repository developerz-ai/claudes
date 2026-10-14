/**
 * Claude Code only applies its full capabilities to model ids it recognises
 * (see developerz-ai/multi-ai-router#211), so tier ids are always real
 * `claude-<family>-<major>[-<minor>][-<date>]` ids — never router aliases such
 * as "claude-opus", never `[1m]`-suffixed variants, and never decorated ids
 * like "claude-opus-5-fast".
 */
export type TierName = "opus" | "sonnet" | "haiku";

export const TIER_FAMILIES: readonly TierName[] = ["opus", "sonnet", "haiku"];

/** Used when the router lists no recognisable id for a family. */
export const DEFAULT_TIERS: Readonly<Record<TierName, string>> = Object.freeze({
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  // The router's catalogue serves haiku 4.5, not 5.5.
  haiku: "claude-haiku-4-5",
});

/**
 * `claude-<family>-<major>-<minor>-<date>` with 1-2 digit version segments and
 * an optional minor (missing means 0); the trailing 8-digit segment is a date,
 * used only to break ties. Everything else — `-fast`, `[1m]`, aliases — fails
 * the anchored match and is ignored.
 */
const TIER_ID_PATTERN =
  /^claude-(?<family>opus|sonnet|haiku)-(?<major>\d{1,2})(?:-(?<minor>\d{1,2}))?(?:-(?<date>\d{8}))?$/;

interface ParsedTierId {
  family: TierName;
  major: number;
  minor: number;
  date: number;
  id: string;
}

/** Parses a tier id, or returns undefined for aliases, `[1m]` variants, and foreign ids. */
export function parseTierId(id: string): ParsedTierId | undefined {
  const groups = TIER_ID_PATTERN.exec(id)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  return {
    // The pattern only admits the three family names.
    family: groups.family as TierName,
    major: Number(groups.major),
    // `claude-opus-5` and `claude-opus-5-0` are the same version.
    minor: groups.minor === undefined ? 0 : Number(groups.minor),
    date: groups.date === undefined ? 0 : Number(groups.date),
    id,
  };
}

function isNewer(candidate: ParsedTierId, incumbent: ParsedTierId): boolean {
  if (candidate.major !== incumbent.major) {
    return candidate.major > incumbent.major;
  }
  if (candidate.minor !== incumbent.minor) {
    return candidate.minor > incumbent.minor;
  }
  return candidate.date > incumbent.date;
}

/**
 * Picks the newest advertised id per family, with `--opus/--sonnet/--haiku`
 * overrides winning unconditionally and DEFAULT_TIERS filling any gap.
 */
export function resolveTiers(
  modelIds: readonly string[],
  overrides: Partial<Record<TierName, string>> = {},
): Record<TierName, string> {
  const newest = new Map<TierName, ParsedTierId>();
  for (const id of modelIds) {
    const parsed = parseTierId(id);
    if (parsed === undefined) {
      continue;
    }
    const incumbent = newest.get(parsed.family);
    if (incumbent === undefined || isNewer(parsed, incumbent)) {
      newest.set(parsed.family, parsed);
    }
  }
  const tiers = {} as Record<TierName, string>;
  for (const family of TIER_FAMILIES) {
    const override = overrides[family];
    tiers[family] =
      override !== undefined && override !== ""
        ? override
        : (newest.get(family)?.id ?? DEFAULT_TIERS[family]);
  }
  return tiers;
}
