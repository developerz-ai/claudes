import { describe, expect, test } from "bun:test";
import { DEFAULT_TIERS, parseTierId, resolveTiers } from "./tiers";

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

  test("a dated id without a minor loses to a higher minor of the same major", () => {
    expect(resolveTiers(["claude-sonnet-4-20250514", "claude-sonnet-4-5-20250929"]).sonnet).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(resolveTiers(["claude-opus-4-20250805", "claude-opus-4-1-20250805"]).opus).toBe(
      "claude-opus-4-1-20250805",
    );
  });

  test("a higher major beats any lower-major id", () => {
    expect(resolveTiers(["claude-opus-5", "claude-opus-4-8"]).opus).toBe("claude-opus-5");
    expect(resolveTiers(["claude-sonnet-6", "claude-sonnet-5-5"]).sonnet).toBe("claude-sonnet-6");
  });

  test("treats a missing minor as 0: claude-opus-4 outranks nothing below 4.1", () => {
    expect(parseTierId("claude-opus-4")?.minor).toBe(0);
    expect(resolveTiers(["claude-opus-4", "claude-opus-3-9"]).opus).toBe("claude-opus-4");
  });

  test("breaks version ties by the newer date", () => {
    expect(resolveTiers(["claude-opus-4-1-20250101", "claude-opus-4-1-20250901"]).opus).toBe(
      "claude-opus-4-1-20250901",
    );
  });

  test("ignores [1m]-suffixed, -fast, and other decorated ids, aliases, and foreign models", () => {
    expect(
      resolveTiers([
        "claude-opus-4-5[1m]",
        "claude-sonnet-4-5[1m]",
        "claude-opus-5-fast",
        "claude-opus-105",
        "claude-opus",
        "claude-3-5-sonnet",
        "gpt-4o",
        "router-alias",
      ]),
    ).toEqual(DEFAULT_TIERS);
  });

  test("defaults fill every family the router does not list", () => {
    expect(DEFAULT_TIERS).toEqual({
      opus: "claude-opus-5-5",
      sonnet: "claude-sonnet-5-5",
      haiku: "claude-haiku-4-5",
    });
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
