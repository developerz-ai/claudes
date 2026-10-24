import { describe, expect, test } from "bun:test";
import { baseUrlSchema, keySchema } from "../config/schema";
import { KEY, ROUTER } from "./fixtures";

describe("the shared fixture pair", () => {
  test("KEY satisfies the real key schema (mar_live_ plus exactly 32 chars)", () => {
    expect(keySchema.safeParse(KEY).success).toBe(true);
  });

  test("ROUTER satisfies the real baseUrl schema", () => {
    expect(baseUrlSchema.safeParse(ROUTER).success).toBe(true);
  });
});
