import { describe, expect, test } from "bun:test";
import {
  isAtLeast,
  isSupportedClaude,
  MIN_CLAUDE_VERSION,
  parseVersionTriple,
} from "./claude-version";

describe("parseVersionTriple", () => {
  test("reads claude --version's full line", () => {
    expect(parseVersionTriple("2.1.300 (Claude Code)\n")).toEqual({
      major: 2,
      minor: 1,
      patch: 300,
    });
  });

  test("reads a bare triple", () => {
    expect(parseVersionTriple("24.6.0")).toEqual({ major: 24, minor: 6, patch: 0 });
  });

  test("undefined when no triple is present", () => {
    for (const text of ["", "Claude Code", "not-a-version", "1.2"]) {
      expect(parseVersionTriple(text)).toBeUndefined();
    }
  });
});

describe("isAtLeast", () => {
  test("compares per segment", () => {
    const at = (v: string) =>
      parseVersionTriple(v) as { major: number; minor: number; patch: number };
    expect(isAtLeast(at("2.2.0"), at("2.1.299"))).toBe(true);
    expect(isAtLeast(at("3.0.0"), at("2.1.299"))).toBe(true);
    expect(isAtLeast(at("2.1.299"), at("2.1.299"))).toBe(true);
    expect(isAtLeast(at("2.1.298"), at("2.1.299"))).toBe(false);
    expect(isAtLeast(at("2.0.999"), at("2.1.299"))).toBe(false);
  });
});

describe("isSupportedClaude", () => {
  test("the minimum itself passes, one patch below fails", () => {
    expect(isSupportedClaude({ major: 2, minor: 1, patch: 299 })).toBe(true);
    expect(isSupportedClaude({ major: 2, minor: 1, patch: 298 })).toBe(false);
  });

  test("the constant is the spike's version", () => {
    expect(MIN_CLAUDE_VERSION).toBe("2.1.299");
  });
});
