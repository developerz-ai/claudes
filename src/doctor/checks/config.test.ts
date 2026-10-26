import { describe, expect, test } from "bun:test";
import type { LoadResult } from "../../config/load";
import { MISSING_CONFIG_MESSAGE } from "../../config/load";
import { assertNoKeyFragment } from "../../test-support/redact";
import { KEY, sampleConfig, TIERS } from "../harness";
import { checkConfig } from "./config";

const ok: LoadResult = { ok: true, config: sampleConfig(), dir: "/home/dev/.config/claudes" };

describe("checkConfig", () => {
  test("a usable config passes with the key as its prefix only", () => {
    const { results, config } = checkConfig({ env: {}, load: () => ok });
    expect(config).toEqual(sampleConfig());
    expect(results).toHaveLength(1);
    const title = results[0]?.title ?? "";
    expect(title).toContain("mar_live_…");
    expect(title).toContain("/home/dev/.config/claudes/config.json");
    expect(title).toContain("claude-opus-5-5");
    assertNoKeyFragment(title, KEY);
  });

  for (const tier of ["opus", "sonnet", "haiku"] as const) {
    for (const prefix of ["", "custom-"]) {
      test(`redacts ${prefix ? "embedded" : "bare"} key-shaped ${tier} IDs without changing config`, () => {
        const id = `${prefix}${KEY}`;
        const original = sampleConfig({ tiers: { ...TIERS, [tier]: id } });
        const snapshot = structuredClone(original);
        const { results, config } = checkConfig({
          env: {},
          load: () => ({ ok: true, config: original, dir: "/home/dev/.config/claudes" }),
        });
        const displayed = { ...TIERS, [tier]: `${prefix}mar_live_…` };
        const title = results[0]?.title ?? "";
        assertNoKeyFragment(title, KEY);
        expect(results).toHaveLength(1);
        expect(results[0]?.status).toBe("PASS");
        expect(title).toBe(
          `config /home/dev/.config/claudes/config.json (key mar_live_…, tiers ${displayed.opus} / ${displayed.sonnet} / ${displayed.haiku})`,
        );
        expect(config).toBe(original);
        expect(config).toEqual(snapshot);
      });
    }
  }

  test("a missing config FAILs with the login remedy", () => {
    const missing: LoadResult = { ok: false, exitCode: 78, message: MISSING_CONFIG_MESSAGE };
    const { results, config } = checkConfig({ env: {}, load: () => missing });
    expect(config).toBeUndefined();
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.fix).toBe(MISSING_CONFIG_MESSAGE);
  });

  test("an insecure config FAILs with the store's remedy", () => {
    const insecure: LoadResult = {
      ok: false,
      exitCode: 78,
      message:
        "refusing to read config: /x/config.json is readable by group or other users — fix it with: chmod 600 /x/config.json",
    };
    const { results } = checkConfig({ env: {}, load: () => insecure });
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.fix).toContain("chmod 600");
  });
});
