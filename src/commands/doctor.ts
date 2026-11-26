import { rmSync } from "node:fs";
import type { LoadResult } from "../config/load";
import type { Env } from "../config/paths";
import { validProfileName } from "../config/profile";
import { keyFragmentOffset } from "../config/schema";
import { checkConfig } from "../doctor/checks/config";
import {
  checkConflicts,
  defaultReadFile,
  type ListDirectory,
  type ReadText,
} from "../doctor/checks/conflicts";
import { checkEffectiveModel } from "../doctor/checks/effective-model";
import { checkLaunchGate } from "../doctor/checks/launch-gate";
import { checkLive, type PostFetch } from "../doctor/checks/live";
import { checkRouter } from "../doctor/checks/router";
import { checkRuntime } from "../doctor/checks/runtime";
import { checkWiring, type ProbeSignalWiring } from "../doctor/checks/wiring";
import { anyFailed, type CheckResult } from "../doctor/results";
import { type RunProc, realRunProc } from "../doctor/run-proc";
import type { RouterStub } from "../doctor/stub-server";
import { resolveCatalog } from "../launch/catalog";
import { isTruthyToggle } from "../launch/provider-switches";
import { resolveExecutable, runningScriptPath } from "../launch/run";
import { readSavedModel, sessionModel } from "../launch/session-model";
import type { FetchLike, ModelEntry } from "../router/client";
import { scrub } from "../router/errors";
import { VERSION } from "../version";

/** The one usage text: the refusal quotes it, and the help output reuses it. */
export const USAGE = "usage: claudes doctor [--live] [--profile <name>]";

export const DOCTOR_FLAGS = ["--live", "--profile"] as const;

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
  readonly listDirectory?: ListDirectory;
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
  let profile: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--profile") {
      const value = argv[index + 1];
      if (profile === undefined && validProfileName(value)) {
        profile = value;
        index++;
        continue;
      }
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
  let key: string | undefined;
  const safeText = (text: string): string =>
    key !== undefined && keyFragmentOffset(text, key) !== undefined
      ? "(details withheld)"
      : scrub(text);
  const report = (incoming: readonly CheckResult[]) => {
    for (const result of incoming) {
      results.push(result);
      deps.stdout(`[${result.status}] ${safeText(result.title)}\n`);
      if (result.fix !== undefined) {
        deps.stdout(`       fix: ${safeText(result.fix)}\n`);
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

  const configCheck = checkConfig({
    env: { ...deps.env, ...(profile === undefined ? {} : { CLAUDES_PROFILE: profile }) },
    load: deps.load,
  });
  key = configCheck.config?.key;
  report(configCheck.results);

  let modelEntries: readonly ModelEntry[] | undefined;
  if (configCheck.config !== undefined) {
    const routerCheck = await checkRouter({
      config: configCheck.config,
      profile: configCheck.profile,
      fetch: deps.fetch,
    });
    report(routerCheck.results);
    modelEntries = routerCheck.modelEntries;
  }

  report(
    checkConflicts({
      env: deps.env,
      platform: deps.platform,
      cwd: deps.cwd,
      readFile: deps.readFile,
      listDirectory: deps.listDirectory,
    }),
  );

  const launchGate = checkLaunchGate(deps.env);
  if (launchGate !== undefined) report([launchGate]);

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

  const catalog = resolveCatalog(configCheck.config, modelEntries);
  const savedModel = readSavedModel(deps.env);
  const model = sessionModel(configCheck.config, catalog, deps.env, savedModel, undefined);
  if (launchGate === undefined) {
    report([
      await checkWiring(
        {
          env: deps.env,
          profile: configCheck.profile,
          launch: { catalog, model, savedModel },
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
  } else {
    report([
      {
        status: "INFO",
        title: "wiring probe skipped because the launcher would refuse this environment",
      },
    ]);
  }
  if (live) {
    report([
      await checkLive({
        config: { ...configCheck.config, tiers: catalog.tiers },
        fetch: deps.postFetch,
      }),
    ]);
  }
  report(checkEffectiveModel(configCheck.config, catalog, model, configCheck.profile));
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
