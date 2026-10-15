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

  test("ignores a relative HOME exactly like a relative XDG_CONFIG_HOME", () => {
    expect(() => configDir({ HOME: "relative/home" })).toThrow();
    expect(configDir({ XDG_CONFIG_HOME: "/xdg", HOME: "relative/home" })).toBe("/xdg/claudes");
    expect(() => configDir({ XDG_CONFIG_HOME: "relative", HOME: "relative/home" })).toThrow();
  });

  test("throws when no absolute base remains", () => {
    for (const env of [{}, { HOME: "" }, { HOME: "relative" }, { XDG_CONFIG_HOME: "" }]) {
      expect(() => configDir(env)).toThrow(
        "cannot find the config directory: set XDG_CONFIG_HOME or HOME to an absolute path",
      );
    }
  });
});

describe("configFile", () => {
  test("names the config file inside the config dir", () => {
    expect(configFile("/home/u/.config/claudes")).toBe("/home/u/.config/claudes/config.json");
  });
});

describe("settingsFile", () => {
  test("names the per-launch settings file by its pid", () => {
    expect(settingsFile("/home/u/.config/claudes", 4242)).toBe(
      "/home/u/.config/claudes/settings.4242.json",
    );
  });
});
