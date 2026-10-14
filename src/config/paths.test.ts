import { describe, expect, test } from "bun:test";
import { configDir, configFile, settingsFile } from "./paths";

describe("configDir", () => {
  test("uses XDG_CONFIG_HOME when it is absolute", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/claudes");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe("/xdg/claudes");
  });

  test("falls back to $HOME/.config when XDG_CONFIG_HOME is unset or empty", () => {
    expect(configDir({ HOME: "/home/u" })).toBe("/home/u/.config/claudes");
    expect(configDir({ XDG_CONFIG_HOME: "", HOME: "/home/u" })).toBe("/home/u/.config/claudes");
  });

  test("ignores a relative XDG_CONFIG_HOME, per the XDG spec", () => {
    expect(configDir({ XDG_CONFIG_HOME: "relative", HOME: "/home/u" })).toBe(
      "/home/u/.config/claudes",
    );
  });

  test("throws when neither XDG_CONFIG_HOME nor HOME is set", () => {
    expect(() => configDir({})).toThrow("neither XDG_CONFIG_HOME nor HOME is set");
  });
});

describe("configFile / settingsFile", () => {
  test("name the two files inside the config dir", () => {
    expect(configFile("/home/u/.config/claudes")).toBe("/home/u/.config/claudes/config.json");
    expect(settingsFile("/home/u/.config/claudes")).toBe("/home/u/.config/claudes/settings.json");
  });
});
