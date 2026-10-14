import { expect, test } from "bun:test";
import pkg from "../package.json";
import { VERSION } from "./version";

test("VERSION constant matches package.json version (drift guard)", () => {
  expect(VERSION).toBe(pkg.version);
});
