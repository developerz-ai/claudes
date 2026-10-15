/** The one verdict shape every doctor check answers with. */
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";

export interface CheckResult {
  readonly status: CheckStatus;
  /** One line naming what was checked and what was found; never a secret. */
  readonly title: string;
  /** The remedy, on its own indented line; omitted when passing clean. */
  readonly fix?: string;
}

/** True when any result is a FAIL: doctor's exit-1 rule. */
export function anyFailed(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.status === "FAIL");
}
