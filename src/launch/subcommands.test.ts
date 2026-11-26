import { expect, test } from "bun:test";
import { classify, offRouterOption } from "./subcommands";

test("recognizes Claude Code first-argument commands", () => {
  for (const word of [
    "attach",
    "logs",
    "stop",
    "kill",
    "rm",
    "respawn",
    "daemon",
    "mcp",
    "plugin",
    "plugins",
    "update",
    "upgrade",
    "install",
    "auth",
    "auto-mode",
    "import",
    "purge",
    "setup-token",
    "gateway",
    "-h",
  ]) {
    expect(classify([word, "--help"])).toBe("manage");
  }
  for (const word of ["agents", "remote-control"]) {
    expect(classify([word, "--help"])).toBe("dispatch");
  }
  expect(classify(["stop the server"])).toBe("session");
  expect(classify(["-p", "stop"])).toBe("session");
});

test("finds off-router modes before the option terminator", () => {
  for (const flag of ["--cloud", "--environment", "--desktop"]) {
    expect(offRouterOption(["-p", "hi", `${flag}=private`])).toBe(flag);
    expect(offRouterOption(["--", flag])).toBeUndefined();
  }
  expect(offRouterOption(["ultrareview", "--help"])).toBe("ultrareview");
  expect(offRouterOption(["--system-prompt", "--cloud", "-p", "hi"])).toBeUndefined();
  expect(offRouterOption(["--unknown", "--cloud"])).toBe("--cloud");
});
