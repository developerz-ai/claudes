import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../../config/paths";
import { writePrivateFile } from "../../config/private-file";
import type { Config } from "../../config/schema";
import { writeConfig } from "../../config/store";
import { buildArgv } from "../../launch/argv";
import { buildChildEnv } from "../../launch/env";
import { buildSettings } from "../../launch/settings";
import type { CheckResult } from "../results";
import type { ProcResult, RunProc } from "../run-proc";
import { createRouterStub, credentialHash, type RouterStub } from "../stub-server";

/** The issue's budget for the whole probe: a normal run finishes in ~20 s. */
export const WIRING_TIMEOUT_MS = 60_000;

/**
 * The probe's claude arguments, on top of the launcher's own argv. Every flag
 * was verified against `claude --help` on 2.1.300 and then live: `--safe-mode`
 * disables hooks, installed plugins, skills and MCP servers (settings-file
 * auth still works), `--strict-mcp-config` keeps MCP servers from starting
 * even if one is configured elsewhere, and `--no-session-persistence` (a
 * --print-only flag) keeps the probe from writing session history. With
 * `-p ping --max-turns 1` the probe answers one turn and exits.
 */
export const WIRING_ARGS = [
  "-p",
  "ping",
  "--max-turns",
  "1",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--safe-mode",
] as const;

export interface WiringDeps {
  readonly env: Env;
  /** Where the running claudes lives, for the settings' apiKeyHelper. */
  readonly nodePath: string;
  readonly scriptPath: string;
  /** The resolved `claude` path, or undefined when it is not on PATH. */
  readonly claudePath: string | undefined;
  readonly runProc: RunProc;
  readonly mkdtemp?: () => string;
  readonly rm?: (path: string) => void;
  readonly createStub?: () => Promise<RouterStub>;
  readonly timeoutMs?: number;
  /**
   * The launcher's argv builder; the seam for the probe's own refusal branch.
   * Defaults to the real one — a test injects a builder to reach the branch
   * without changing the probe's arguments.
   */
  readonly buildArgv?: typeof buildArgv;
}

const defaultMkdtemp = (): string => mkdtempSync(join(tmpdir(), "claudes-doctor-"));
const defaultRm = (path: string): void => {
  rmSync(path, { recursive: true, force: true });
};

/**
 * Check 5: the wiring proof, zero quota. Spawns the real `claude` exactly the
 * way the launcher would — the same buildSettings/buildChildEnv/buildArgv —
 * but with the base URL pointed at a local recording stub, and passes only if
 * that stub saw a POST /v1/messages whose credential hash is the configured
 * key's, with a configured tier as the model, and no other credential
 * anywhere. The key itself never appears in the generated settings file, in
 * the probe's output, or in the stub's records (SHA-256 hex only). It DOES
 * land in the throwaway probe config at `<tempRoot>/xdg/claudes/config.json`
 * (mode 0600) — `claudes key` can only serve it from a config — so the
 * finally-block's rm is what keeps it off disk permanently.
 *
 * Two deliberate probe substitutions, both because the stub is not the real
 * router: the settings' base URL (the point of the probe) and the child's
 * HOME/XDG_CONFIG_HOME, which point at a throwaway copy of the config with the
 * stub's base URL — `claudes key` refuses to serve the key when the settings'
 * base URL is not the config's, so the probe config must agree with the stub.
 * The throwaway HOME also keeps claude from touching the developer's real
 * state, and keeps their user settings from making the probe non-determinic.
 */
export async function checkWiring(deps: WiringDeps, config: Config): Promise<CheckResult> {
  if (deps.claudePath === undefined) {
    return {
      status: "FAIL",
      title: "wiring probe: claude not found on PATH",
      fix: "install Claude Code and make `claude` resolvable on PATH",
    };
  }
  const mkdtemp = deps.mkdtemp ?? defaultMkdtemp;
  const rm = deps.rm ?? defaultRm;
  const createStub = deps.createStub ?? createRouterStub;

  let tempRoot: string | undefined;
  let stub: RouterStub | undefined;
  try {
    tempRoot = mkdtemp();
    stub = await createStub();

    // The probe config: the real key and tiers, the stub's base URL.
    const probeConfig: Config = { ...config, baseUrl: stub.baseUrl };
    const settingsDir = join(tempRoot, "settings");
    const settingsPath = join(settingsDir, "settings.json");
    writePrivateFile(
      settingsPath,
      `${JSON.stringify(buildSettings(probeConfig, deps, deps.env), null, 2)}\n`,
      {
        noun: "wiring-probe settings",
        remedy: "re-run `claudes doctor`",
      },
    );
    const probeXdg = join(tempRoot, "xdg");
    writeConfig(join(probeXdg, "claudes", "config.json"), probeConfig);
    const probeHome = join(tempRoot, "home");
    mkdirSync(probeHome, { recursive: true, mode: 0o700 });

    const argv = (deps.buildArgv ?? buildArgv)([...WIRING_ARGS], settingsPath);
    if (!argv.ok) {
      // The probe's arguments are claudes' own constant, not the user's, so a
      // refusal here is a claudes defect — the remedy must not send the user
      // to `claudes login` for a config they never broke.
      return {
        status: "FAIL",
        title: `wiring probe: ${argv.message}`,
        fix: "the probe's own arguments were refused by claudes — this is a claudes defect, not a config problem; update claudes and re-run `claudes doctor`",
      };
    }
    const childEnv = buildChildEnv(deps.env);
    childEnv.HOME = probeHome;
    childEnv.XDG_CONFIG_HOME = probeXdg;

    const proc = await deps.runProc(deps.claudePath, argv.argv, {
      env: childEnv,
      timeoutMs: deps.timeoutMs ?? WIRING_TIMEOUT_MS,
    });
    return evaluate(stub, config, proc, deps.timeoutMs ?? WIRING_TIMEOUT_MS);
  } catch (err) {
    return {
      status: "FAIL",
      title: `wiring probe: could not run (${errorToken(err)})`,
      fix: "re-run `claudes doctor`",
    };
  } finally {
    // Best-effort cleanup: a leftover temp dir still holds the probe config
    // with the real key inside (mode 0600), so this rm matters; the OS's tmp
    // sweeping is the backstop when it fails.
    try {
      await stub?.close();
    } catch {
      // the socket is gone either way
    }
    if (tempRoot !== undefined) {
      try {
        rm(tempRoot);
      } catch {
        // a later doctor run's tmp cleaning covers it
      }
    }
  }
}

/** The PASS/WARN/FAIL verdict over what the stub recorded and how claude left. */
function evaluate(
  stub: RouterStub,
  config: Config,
  proc: ProcResult,
  timeoutMs: number,
): CheckResult {
  const expected = credentialHash(config.key);
  const requests = stub.requests();
  const foreign = requests
    .flatMap((request) => request.credentials)
    .filter((c) => c.hash !== expected);
  if (foreign.length > 0) {
    return {
      status: "FAIL",
      title: `wiring probe: ${foreign.length} credential${foreign.length === 1 ? "" : "s"} other than the configured router key reached the probe`,
      fix: "remove the competing credential (see the conflicts check above) and re-run `claudes doctor`",
    };
  }
  const hits = requests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/v1/messages" &&
      request.credentials.some((c) => c.hash === expected),
  );
  if (hits.length === 0) {
    if (proc.timedOut) {
      return {
        status: "FAIL",
        title: `wiring probe: claude did not finish within ${Math.round(timeoutMs / 1000)} s`,
        fix: "retry `claudes doctor`; a cold first start can outlast the probe",
      };
    }
    return {
      status: "FAIL",
      title: `wiring probe: claude ${describeExit(proc)} without sending a request to the probe`,
      fix: "the generated settings file must exist and be readable for the whole run — re-run `claudes doctor` and check the conflicts above",
    };
  }
  const tierIds = new Set<string>([config.tiers.opus, config.tiers.sonnet, config.tiers.haiku]);
  if (config.subagentModel !== undefined) {
    tierIds.add(config.subagentModel);
  }
  const hit = hits.find(
    (candidate) => candidate.model !== undefined && tierIds.has(candidate.model),
  );
  if (hit === undefined) {
    const model = hits.at(0)?.model;
    return {
      status: "FAIL",
      title: `wiring probe: the request's model (${model ?? "unreadable"}) is not a configured tier`,
      fix: "re-run `claudes login` so the pinned tiers match what the router serves",
    };
  }
  if (proc.timedOut || proc.code === null || proc.code !== 0) {
    return {
      status: "WARN",
      title: `wiring probe: the router key reached the probe as the only credential (model ${hit.model}), but claude ${describeExit(proc)}`,
      fix: "the credential path is proven; the exit status is a separate problem",
    };
  }
  return {
    status: "PASS",
    title: `wiring probe: claude sent the router key to the stub and nothing else (model ${hit.model})`,
  };
}

/** "exited 1" / "was killed by SIGKILL" / "could not run" — never a message body. */
function describeExit(proc: ProcResult): string {
  if (proc.signal !== null) {
    return `was killed by ${proc.signal}`;
  }
  if (proc.code !== null) {
    return `exited ${proc.code}`;
  }
  return "could not run";
}

/** Class-shaped error names only; an errno-shaped code wins when present. */
function errorToken(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
      return code;
    }
  }
  return err instanceof Error && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
}
