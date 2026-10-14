import { describe, expect, test } from "bun:test";
import { DEFAULT_TIERS, resolveTiers } from "./tiers";

describe("resolveTiers", () => {
  test("picks the newest id per family", () => {
    expect(
      resolveTiers([
        "claude-opus-4-1",
        "claude-opus-5-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5",
        "claude-haiku-3-5",
      ]),
    ).toEqual({
      opus: "claude-opus-5-5",
      sonnet: "claude-sonnet-4-5-20250929",
      haiku: "claude-haiku-4-5",
    });
  });

  test("breaks version ties by the newer date", () => {
    expect(resolveTiers(["claude-opus-4-1-20250101", "claude-opus-4-1-20250901"]).opus).toBe(
      "claude-opus-4-1-20250901",
    );
  });

  test("ignores [1m]-suffixed ids, aliases, and foreign models", () => {
    expect(
      resolveTiers([
        "claude-opus-4-5[1m]",
        "claude-sonnet-4-5[1m]",
        "claude-opus",
        "claude-3-5-sonnet",
        "gpt-4o",
        "router-alias",
      ]),
    ).toEqual(DEFAULT_TIERS);
  });

  test("falls back to the defaults when the router lists nothing recognisable", () => {
    expect(resolveTiers([])).toEqual(DEFAULT_TIERS);
    expect(resolveTiers(["claude-haiku-4-5"])).toEqual({
      opus: DEFAULT_TIERS.opus,
      sonnet: DEFAULT_TIERS.sonnet,
      haiku: "claude-haiku-4-5",
    });
  });

  test("overrides win over everything, including the newest advertised id", () => {
    expect(
      resolveTiers(["claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"], {
        opus: "claude-opus-9-9",
        haiku: "claude-haiku-4-5-20240725",
      }),
    ).toEqual({
      opus: "claude-opus-9-9",
      sonnet: "claude-sonnet-4-5",
      haiku: "claude-haiku-4-5-20240725",
    });
  });
});
