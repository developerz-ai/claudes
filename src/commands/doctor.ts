import { rmSync } from "node:fs";
import type { LoadResult } from "../config/load";
import type { Env } from "../config/paths";
import { checkConfig } from "../doctor/checks/config";
import { checkConflicts, defaultReadFile, type ReadText } from "../doctor/checks/conflicts";
import { checkEffectiveModel } from "../doctor/checks/effective-model";
import { checkLive, type PostFetch } from "../doctor/checks/live";
import { checkRouter } from "../doctor/checks/router";
import { checkRuntime } from "../doctor/checks/runtime";
import { checkWiring, type ProbeSignalWiring } from "../doctor/checks/wiring";
import { anyFailed, type CheckResult } from "../doctor/results";
import { type RunProc, realRunProc } from "../doctor/run-proc";
import type { RouterStub } from "../doctor/stub-server";
import { isTruthyToggle } from "../launch/provider-switches";
import { resolveExecutable, runningScriptPath } from "../launch/run";
import type { FetchLike } from "../router/client";
import { scrub } from "../router/errors";
import { VERSION } from "../version";

const USAGE = "usage: claudes doctor [--live]";

export interface DoctorDeps {
  readonly env: Env;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly cwd: string;
  /** Where the running claudes lives, for the wiring probe's apiKeyHelper. */
  readonly nodePath: string;
  readonly scriptPath: string;
  /** GET-shaped fetch for the router checks. */
  readonly fetch: FetchLike;
  /** POST-shaped fetch for the --live request. */
  readonly postFetch: PostFetch;
  readonly runProc: RunProc;
  readonly resolveExecutable?: (name: string, env: Env) => string | undefined;
  readonly load?: (env: Env) => LoadResult;
  readonly readFile?: ReadText;
  /**
   * Creates the wiring probe's throwaway tree under the config directory.
   * Defaults to the probe's own `createProbeDir`; the seam exists so the
   * probe's directory can be watched, never so it can be moved elsewhere.
   */
  readonly probeDir?: (base: string) => string;
  readonly rm?: (path: string) => void;
  /** The signals the wiring probe traps so it can delete the key copy. */
  readonly signals?: ProbeSignalWiring;
  readonly createStub?: () => Promise<RouterStub>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `claudes doctor`: runs every check in order, printing each verdict as it
 * arrives (the wiring probe alone can take a minute), and answers 1 when any
 * check FAILed, 0 otherwise. Every line passes through scrub(); the key is
 * only ever shown as its prefix, and the wiring probe proves the credential
 * path with hashes instead of values.
 */
export async function runDoctor(argv: readonly string[], deps: DoctorDeps): Promise<number> {
  let live = false;
  for (const [index, arg] of argv.entries()) {
    if (arg === "--live") {
      live = true;
      continue;
    }
    deps.stderr(scrub(`claudes doctor: unknown argument #${index + 1}\n${USAGE}\n`));
    return 64;
  }

  if (isTruthyToggle(deps.env.BUN_CONFIG_VERBOSE_FETCH)) {
    deps.stderr(
      scrub(
        "claudes doctor: refusing: BUN_CONFIG_VERBOSE_FETCH is set, so the router key would be printed\n",
      ),
    );
    return 64;
  }

  const results: CheckResult[] = [];
  const report = (incoming: readonly CheckResult[]) => {
    for (const result of incoming) {
      results.push(result);
      deps.stdout(scrub(`[${result.status}] ${result.title}\n`));
      if (result.fix !== undefined) {
        deps.stdout(scrub(`       fix: ${result.fix}\n`));
      }
    }
  };

  deps.stdout(scrub(`claudes doctor (claudes ${VERSION})\n`));

  const claudePath = (deps.resolveExecutable ?? resolveExecutable)("claude", deps.env);
  report(
    await checkRuntime({
      platform: deps.platform,
      nodeVersion: deps.nodeVersion,
      env: deps.env,
      claudePath,
      runProc: deps.runProc,
    }),
  );

  const configCheck = checkConfig({ env: deps.env, load: deps.load });
  report(configCheck.results);

  let modelIds: string[] | undefined;
  if (configCheck.config !== undefined) {
    const routerCheck = await checkRouter({ config: configCheck.config, fetch: deps.fetch });
    report(routerCheck.results);
    modelIds = routerCheck.modelIds;
  }

  report(
    checkConflicts({
      env: deps.env,
      platform: deps.platform,
      cwd: deps.cwd,
      readFile: deps.readFile,
    }),
  );

  if (configCheck.config === undefined) {
    report([
      {
        status: "INFO",
        title: "router, wiring and effective-model checks skipped — no usable config",
      },
    ]);
    if (live) {
      report([{ status: "INFO", title: "live request skipped — no usable config" }]);
    }
    return anyFailed(results) ? 1 : 0;
  }

  report([
    await checkWiring(
      {
        env: deps.env,
        nodePath: deps.nodePath,
        scriptPath: deps.scriptPath,
        claudePath,
        runProc: deps.runProc,
        probeDir: deps.probeDir,
        rm: deps.rm,
        signals: deps.signals,
        createStub: deps.createStub,
      },
      configCheck.config,
    ),
  ]);
  if (live) {
    report([await checkLive({ config: configCheck.config, fetch: deps.postFetch })]);
  }
  if (modelIds !== undefined) {
    report(checkEffectiveModel({ config: configCheck.config, modelIds }));
  } else {
    report([{ status: "INFO", title: "effective models skipped — /v1/models did not answer" }]);
  }
  return anyFailed(results) ? 1 : 0;
}

/** Injectables for the real process; what main.ts passes to runDoctor(). */
export function realDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    nodePath: process.execPath,
    scriptPath: runningScriptPath(),
    fetch: (input, init) => fetch(input, init),
    postFetch: (url, init) => fetch(url, init),
    runProc: realRunProc,
    readFile: defaultReadFile,
    rm: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
