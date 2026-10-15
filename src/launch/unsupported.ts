/**
 * Features the router cannot serve yet, turned off only in claudes sessions.
 * Each row names the router issue that will remove it, so the table can be
 * emptied as the router catches up.
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
  /** The router issue whose fix removes this row. */
  readonly issue: string;
}

export const UNSUPPORTED_FEATURES: readonly UnsupportedFeature[] = [
  {
    feature: "WebSearch",
    reason: "the router's subscription path rejects server tools with HTTP 400",
    removedBy: { kind: "deny", rule: "WebSearch" },
    issue: "developerz-ai/multi-ai-router#210",
  },
  {
    feature: "advisor",
    reason: "the advisor is a server tool the router rejects on every turn",
    removedBy: { kind: "env", name: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL", value: "1" },
    issue: "developerz-ai/multi-ai-router#210",
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
