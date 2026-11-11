/**
 * Features the router cannot serve yet, turned off only in claudes sessions.
 * Each row names the router issue that will remove it — or records that the
 * router has no open tracker for it — so the table can be emptied as the
 * router catches up.
 */
export type RemovedBy =
  | { readonly kind: "deny"; readonly rule: string }
  | { readonly kind: "env"; readonly name: string; readonly value: string };

export interface UnsupportedFeature {
  /** The Claude Code feature that is turned off. */
  readonly feature: string;
  /** Why — internal documentation only, never quoted into the generated settings. */
  readonly reason: string;
  /** How a claudes session turns the feature off. */
  readonly removedBy: RemovedBy;
  /**
   * The router issue whose fix removes this row, in `owner/repo#number` form.
   *
   * `null` when the router has no open tracker for the gap: the epic that
   * recorded it (multi-ai-router#210) closed on 2026-11-11 and nothing else is
   * open for it. A closed issue is not a tracker, and the README's known-gaps
   * table cites version-pinned source inspection instead — so the source says
   * the same thing here.
   */
  readonly issue: string | null;
}

export const UNSUPPORTED_FEATURES: readonly UnsupportedFeature[] = [
  {
    feature: "WebSearch",
    reason:
      "the router's SDK path rejects non-custom server tools, and claudes turns the tool off in either transport: this is launcher policy, not a router gap",
    removedBy: { kind: "deny", rule: "WebSearch" },
    issue: null,
  },
  {
    feature: "advisor",
    reason:
      "the advisor is a server tool the router's SDK path rejects, and claudes turns it off in either transport: this is launcher policy, not a router gap",
    removedBy: { kind: "env", name: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL", value: "1" },
    issue: null,
  },
];

/** The `permissions.deny` entries derived from the table. */
export function denyRules(): string[] {
  return UNSUPPORTED_FEATURES.flatMap((f) =>
    f.removedBy.kind === "deny" ? [f.removedBy.rule] : [],
  );
}

/** The env overrides derived from the table. */
export function disabledEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const feature of UNSUPPORTED_FEATURES) {
    if (feature.removedBy.kind === "env") {
      env[feature.removedBy.name] = feature.removedBy.value;
    }
  }
  return env;
}
