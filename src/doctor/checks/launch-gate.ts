import type { Env } from "../../config/paths";
import {
  firstHostManagedEnv,
  firstUnknownReroutingUseToggle,
} from "../../launch/provider-switches";
import type { CheckResult } from "../results";

export function checkLaunchGate(env: Env): CheckResult | undefined {
  const refused = firstUnknownReroutingUseToggle(env) ?? firstHostManagedEnv(env);
  if (refused === undefined) return undefined;
  return {
    status: "FAIL",
    title: `launcher refuses ${refused} because it can redirect a session away from the router`,
    fix: `unset ${refused} before launching claudes`,
  };
}
