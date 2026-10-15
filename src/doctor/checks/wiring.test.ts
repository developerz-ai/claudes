import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoKeyFragment } from "../../test-support/redact";
import { FOREIGN_CREDENTIAL, fakeClaudeProc, KEY, sampleConfig, TIERS } from "../harness";
import { checkWiring, WIRING_ARGS } from "./wiring";

const CLAUDE = "/usr/local/bin/claude";
const NODE = "/usr/local/bin/node";
const SCRIPT = "/opt/claudes/bin/claudes.js";

interface Scratch {
  readonly dirs: string[];
  mkdtemp: () => string;
}

/** Real temp dirs, removed after each test, tracked through the injected seam. */
function scratch(): Scratch {
  const dirs: string[] = [];
  return {
    dirs,
    mkdtemp: () => {
      const dir = mkdtempSync(join(tmpdir(), "wiring-test-"));
      dirs.push(dir);
      return dir;
    },
  };
}

function cleanup(s: Scratch): void {
  for (const dir of s.dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deps(
  s: Scratch,
  runProc: Parameters<typeof checkWiring>[0]["runProc"],
): Parameters<typeof checkWiring>[0] {
  return {
    env: { HOME: "/home/dev", PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "sk-ant-personal" },
    nodePath: NODE,
    scriptPath: SCRIPT,
    claudePath: CLAUDE,
    runProc,
    mkdtemp: s.mkdtemp,
    rm: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

describe("checkWiring", () => {
  test("passes when the stub sees the configured key's hash, a tier model, and nothing else", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("PASS");
      expect(result.title).toContain("model claude-sonnet-5-5");
      // The probe's claude argv is the launcher's own: --settings first, then
      // the ping turn and the isolation flags.
      const argv = fake.calls[0]?.argv ?? [];
      expect(argv[0]).toBe("--settings");
      expect(argv.slice(2)).toEqual([...WIRING_ARGS]);
      // The child env is the launcher's stripped env, redirected to the probe's
      // throwaway HOME/XDG so `claudes key` cooperates with the stub's URL.
      const env = fake.calls[0]?.env ?? {};
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.HOME).toBe(join(s.dirs[0] as string, "home"));
      expect(env.XDG_CONFIG_HOME).toBe(join(s.dirs[0] as string, "xdg"));
      // The temp tree is cleaned up.
      expect(s.dirs.length).toBe(1);
      expect(existsSync(s.dirs[0] as string)).toBe(false);
    } finally {
      cleanup(s);
    }
  });

  test("writes a 0600 settings file in a 0700 dir, built by the launcher's builders", async () => {
    const s = scratch();
    let seen: { path: string; text: string; fileMode: number; dirMode: number } | undefined;
    const capturing = fakeClaudeProc();
    const runProc = async (...args: Parameters<typeof capturing.runProc>) => {
      const call = { command: args[0], argv: args[1], env: args[2].env ?? {} };
      const settingsAt = call.argv.indexOf("--settings");
      const path = call.argv[settingsAt + 1] as string;
      // Capture the facts during the run: the check removes its temp tree
      // before returning, so nothing is left to stat afterwards.
      seen = {
        path,
        text: readFileSync(path, "utf8"),
        fileMode: statSync(path).mode & 0o777,
        dirMode: statSync(join(path, "..")).mode & 0o777,
      };
      return await capturing.runProc(...args);
    };
    try {
      const result = await checkWiring(deps(s, runProc), sampleConfig());
      expect(result.status).toBe("PASS");
      const facts = seen as { path: string; text: string; fileMode: number; dirMode: number };
      expect(facts.fileMode).toBe(0o600);
      expect(facts.dirMode).toBe(0o700);
      const settings = JSON.parse(facts.text) as {
        readonly apiKeyHelper: string;
        readonly env: Record<string, string>;
      };
      // The launcher's key helper, verbatim.
      expect(settings.apiKeyHelper).toBe(`'${NODE}' '${SCRIPT}' key`);
      // The base URL points at the stub, and the key never enters the file.
      expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(TIERS.sonnet);
      assertNoKeyFragment(facts.text, KEY);
    } finally {
      cleanup(s);
    }
  });

  test("PROVEN NEGATIVE: FAILs when the settings file is removed before claude reads it", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ removeSettings: true });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("without sending a request to the probe");
      expect(result.title).toContain("exited 1");
      expect(result.fix).toContain("settings file");
    } finally {
      cleanup(s);
    }
  });

  test("PROVEN NEGATIVE: FAILs when a different credential reaches the stub", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ credential: FOREIGN_CREDENTIAL });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("other than the configured router key");
      expect(result.fix).toContain("conflicts check");
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when the request's model is not a configured tier", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ model: "claude-opus-9-9" });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("claude-opus-9-9");
      expect(result.title).toContain("not a configured tier");
    } finally {
      cleanup(s);
    }
  });

  test("FAILs when claude is missing from PATH", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc();
      const result = await checkWiring(
        { ...deps(s, fake.runProc), claudePath: undefined },
        sampleConfig(),
      );
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("claude not found on PATH");
    } finally {
      cleanup(s);
    }
  });

  test("WARNs when the credential path is proven but claude exits non-zero", async () => {
    const s = scratch();
    try {
      const fake = fakeClaudeProc({ exitCode: 3 });
      const result = await checkWiring(deps(s, fake.runProc), sampleConfig());
      expect(result.status).toBe("WARN");
      expect(result.title).toContain("exited 3");
    } finally {
      cleanup(s);
    }
  });

  test("FAILs on timeout with the seconds named", async () => {
    const s = scratch();
    try {
      const runProc = async () => ({
        ok: false,
        code: null,
        signal: null,
        timedOut: true,
        stdout: "",
      });
      const result = await checkWiring({ ...deps(s, runProc), timeoutMs: 60_000 }, sampleConfig());
      expect(result.status).toBe("FAIL");
      expect(result.title).toContain("did not finish within 60 s");
    } finally {
      cleanup(s);
    }
  });
});
