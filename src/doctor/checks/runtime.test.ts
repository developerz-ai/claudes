import { describe, expect, test } from "bun:test";
import { versionProc } from "../harness";
import type { ProcOptions, RunProc } from "../run-proc";
import { checkRuntime, type RuntimeDeps } from "./runtime";

const ENV = { PATH: "/usr/bin" } as const;
const CLAUDE = "/usr/local/bin/claude";

function deps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    platform: "linux",
    nodeVersion: "24.6.0",
    env: ENV,
    claudePath: CLAUDE,
    runProc: versionProc("2.1.300 (Claude Code)\n"),
    ...overrides,
  };
}

describe("checkRuntime", () => {
  test("a healthy runtime passes with both versions named", async () => {
    const results = await checkRuntime(deps());
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ status: "PASS", title: "node 24.6.0" });
    expect(results[1]?.status).toBe("PASS");
    expect(results[1]?.title).toContain("claude 2.1.300");
    expect(results[1]?.title).toContain(CLAUDE);
  });

  test("native Windows is a single FAIL that says use WSL", async () => {
    const results = await checkRuntime(deps({ platform: "win32" }));
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.title).toContain("use WSL");
  });

  test("node 21 fails with the minimum named", async () => {
    const results = await checkRuntime(deps({ nodeVersion: "21.7.3" }));
    expect(results[0]?.status).toBe("FAIL");
    expect(results[0]?.title).toContain("older than 22");
  });

  test("an unreadable node version fails", async () => {
    const results = await checkRuntime(deps({ nodeVersion: "weird" }));
    expect(results[0]?.status).toBe("FAIL");
  });

  test("claude missing from PATH fails", async () => {
    const results = await checkRuntime(deps({ claudePath: undefined }));
    expect(results[1]?.status).toBe("FAIL");
    expect(results[1]?.title).toContain("claude not found on PATH");
  });

  test("claude below the tested version fails with the minimum named", async () => {
    const results = await checkRuntime(deps({ runProc: versionProc("2.1.100 (Claude Code)") }));
    expect(results[1]?.status).toBe("FAIL");
    expect(results[1]?.title).toContain("2.1.100");
    expect(results[1]?.title).toContain("2.1.299");
    expect(results[1]?.fix).toContain("update Claude Code");
  });

  test("the exact tested version passes", async () => {
    const results = await checkRuntime(deps({ runProc: versionProc("2.1.299 (Claude Code)") }));
    expect(results[1]?.status).toBe("PASS");
  });

  test("a version line without a triple fails", async () => {
    const results = await checkRuntime(deps({ runProc: versionProc("Claude Code") }));
    expect(results[1]?.status).toBe("FAIL");
  });

  test("a --version that exits non-zero yet prints a version line fails", async () => {
    const results = await checkRuntime(
      deps({ runProc: versionProc("2.1.300 (Claude Code)\n", 1) }),
    );
    expect(results[1]?.status).toBe("FAIL");
    expect(results[1]?.title).toContain("exit 1");
    expect(results[1]?.fix).toContain("reinstall Claude Code");
  });

  test("the version probe runs under the injected env", async () => {
    let seen: ProcOptions["env"];
    const runProc: RunProc = async (_command, _argv, options) => {
      seen = options.env;
      return { ok: true, code: 0, signal: null, timedOut: false, stdout: "2.1.300\n" };
    };
    await checkRuntime(deps({ runProc }));
    expect(seen).toBe(ENV);
  });

  test("a --version probe that times out or cannot run fails", async () => {
    const timedOut = await checkRuntime(
      deps({
        runProc: async () => ({ ok: false, code: null, signal: null, timedOut: true, stdout: "" }),
      }),
    );
    expect(timedOut[1]?.status).toBe("FAIL");
    expect(timedOut[1]?.title).toContain("did not finish");

    const dead = await checkRuntime(
      deps({
        runProc: async () => ({ ok: false, code: null, signal: null, timedOut: false, stdout: "" }),
      }),
    );
    expect(dead[1]?.status).toBe("FAIL");
    expect(dead[1]?.title).toContain("did not start");
  });
});
