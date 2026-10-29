import { describe, expect, test } from "bun:test";
import { scrubWithPrefix } from "./errors";

/**
 * The prefix guards in errors.ts are only observable through a prefix that
 * carries a regex metacharacter or a "$": the canonical prefix has neither, so
 * deleting the escape (or the function replacement) leaves every other test
 * green. These are the two cases that fail when a guard goes.
 */
describe("scrubWithPrefix", () => {
  test("matches the prefix as literal text, not as a pattern", () => {
    // A "." in the prefix is a metacharacter: matched as text it redacts only
    // its own run; matched as a pattern it would also swallow "marXlive_".
    expect(scrubWithPrefix("mar.live_", "mar.live_SECRET")).toBe("mar.live_…");
    expect(scrubWithPrefix("mar.live_", "marXlive_SECRET")).toBe("marXlive_SECRET");
    // A "[" in the prefix is a metacharacter too: escaped, the pattern stays
    // valid and still matches only its own literal run.
    expect(() => scrubWithPrefix("mar[live_", "mar[live_SECRET")).not.toThrow();
    expect(scrubWithPrefix("mar[live_", "mar[live_SECRET")).toBe("mar[live_…");
    expect(scrubWithPrefix("mar[live_", "marllive_SECRET")).toBe("marllive_SECRET");
  });

  test("replaces with the literal prefix, never a replacement pattern", () => {
    // "$&" in a replacement string means "the matched text": as a string
    // replacement the redaction would echo the matched run back.
    const scrubbed = scrubWithPrefix("mar$&live_", "mar$&live_SECRET");
    expect(scrubbed).toBe("mar$&live_…");
    expect(scrubbed).not.toContain("SECRET");
  });
});
