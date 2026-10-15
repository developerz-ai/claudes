import { describe, expect, test } from "bun:test";
import type { Env } from "../config/paths";
import {
  firstHostManagedEnv,
  firstReroutingUseToggle,
  firstSetProviderSwitch,
  firstUnknownReroutingUseToggle,
  HOST_MANAGED_ENV,
  isTruthyToggle,
} from "./provider-switches";

describe("firstHostManagedEnv", () => {
  test("no host-managed names set: undefined", () => {
    expect(firstHostManagedEnv({})).toBeUndefined();
    expect(firstHostManagedEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5" })).toBeUndefined();
  });

  test("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST truthy is refused", () => {
    for (const value of ["1", "true", "yes", "TRUE"]) {
      expect(firstHostManagedEnv({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: value })).toBe(
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      );
    }
  });

  test("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST falsy is not", () => {
    for (const value of ["", "0", "false", "FALSE"]) {
      expect(firstHostManagedEnv({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: value })).toBeUndefined();
    }
  });

  test("CLAUDE_CODE_HOST_AUTH_ENV_VAR: any non-empty value is refused", () => {
    // It names the env var holding the host's credential, so "0" and "false"
    // are names like any other.
    for (const value of ["ANTHROPIC_API_KEY", "0", "false", " "]) {
      expect(firstHostManagedEnv({ CLAUDE_CODE_HOST_AUTH_ENV_VAR: value })).toBe(
        "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
      );
    }
  });

  test("CLAUDE_CODE_HOST_AUTH_ENV_VAR empty or unset is not", () => {
    expect(firstHostManagedEnv({ CLAUDE_CODE_HOST_AUTH_ENV_VAR: "" })).toBeUndefined();
  });

  test("both set: the flag wins (stable order)", () => {
    const env: Env = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY",
    };
    expect(firstHostManagedEnv(env)).toBe("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST");
  });

  test("the constant holds exactly the two host-managed names", () => {
    expect([...HOST_MANAGED_ENV]).toEqual([
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    ]);
  });
});

describe("isTruthyToggle", () => {
  test("unset, '', '0' and 'false' are off; everything else is on (case-insensitive)", () => {
    for (const off of [undefined, "", "0", "false", "FALSE", "False"]) {
      expect(isTruthyToggle(off)).toBe(false);
    }
    for (const on of ["1", "true", "yes", " "]) {
      expect(isTruthyToggle(on)).toBe(true);
    }
  });
});

describe("firstSetProviderSwitch", () => {
  test("no switch set: undefined", () => {
    expect(firstSetProviderSwitch({})).toBeUndefined();
  });

  test("a truthy known switch yields its name", () => {
    expect(firstSetProviderSwitch({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(
      "CLAUDE_CODE_USE_BEDROCK",
    );
  });

  test("two switches set: the stable PROVIDER_SWITCHES order wins", () => {
    expect(
      firstSetProviderSwitch({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_BEDROCK: "1",
      }),
    ).toBe("CLAUDE_CODE_USE_BEDROCK");
  });

  test("falsy values are off: undefined", () => {
    for (const value of ["", "0", "false"] as const) {
      expect(firstSetProviderSwitch({ CLAUDE_CODE_USE_BEDROCK: value })).toBeUndefined();
    }
  });

  test("a benign allowlisted toggle is not a provider switch", () => {
    expect(firstSetProviderSwitch({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" })).toBeUndefined();
  });

  test("an unknown CLAUDE_CODE_USE_ toggle is not a provider switch", () => {
    expect(firstSetProviderSwitch({ CLAUDE_CODE_USE_FOO: "1" })).toBeUndefined();
  });
});

describe("firstUnknownReroutingUseToggle", () => {
  test("a benign allowlisted toggle yields undefined", () => {
    expect(
      firstUnknownReroutingUseToggle({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }),
    ).toBeUndefined();
  });

  test("an unknown truthy toggle yields its name", () => {
    expect(firstUnknownReroutingUseToggle({ CLAUDE_CODE_USE_FOO: "1" })).toBe(
      "CLAUDE_CODE_USE_FOO",
    );
  });

  test("a known switch is not unknown: undefined (the settings pin covers it)", () => {
    expect(firstUnknownReroutingUseToggle({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBeUndefined();
  });

  test("falsy unknown toggles yield undefined", () => {
    for (const value of ["", "0", "false"] as const) {
      expect(firstUnknownReroutingUseToggle({ CLAUDE_CODE_USE_FOO: value })).toBeUndefined();
    }
  });

  test("several unknown toggles: the sorted name wins", () => {
    expect(
      firstUnknownReroutingUseToggle({
        CLAUDE_CODE_USE_ZED: "1",
        CLAUDE_CODE_USE_ALPHA: "1",
      }),
    ).toBe("CLAUDE_CODE_USE_ALPHA");
  });
});

describe("firstReroutingUseToggle", () => {
  test("a benign allowlisted toggle alone yields undefined", () => {
    expect(firstReroutingUseToggle({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" })).toBeUndefined();
  });

  test("an unknown truthy toggle yields its name", () => {
    expect(firstReroutingUseToggle({ CLAUDE_CODE_USE_FOO: "1" })).toBe("CLAUDE_CODE_USE_FOO");
  });

  test("a provider switch yields its name", () => {
    expect(firstReroutingUseToggle({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(
      "CLAUDE_CODE_USE_BEDROCK",
    );
  });

  test("falsy values yield undefined", () => {
    for (const value of ["", "0", "false"] as const) {
      expect(
        firstReroutingUseToggle({
          CLAUDE_CODE_USE_BEDROCK: value,
          CLAUDE_CODE_USE_FOO: value,
        }),
      ).toBeUndefined();
    }
  });

  test("a known switch wins over an unknown toggle (stable known-first order)", () => {
    expect(
      firstReroutingUseToggle({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOO: "1",
      }),
    ).toBe("CLAUDE_CODE_USE_VERTEX");
  });
});
