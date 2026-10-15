import type { Env } from "../../config/paths";
import {
  isSupportedClaude,
  MIN_CLAUDE_VERSION,
  parseVersionTriple,
  printableVersion,
} from "../claude-version";
import type { CheckResult } from "../results";
import type { RunProc } from "../run-proc";

/** The minimum Node line doctor accepts; the shipped file requires it too. */
const MIN_NODE_MAJOR = 22;

/** `claude --version` should answer in well under a second; 10 is generous. */
const VERSION_TIMEOUT_MS = 10_000;

const WINDOWS_FAIL_TITLE = "native Windows is not supported — use WSL";
const WINDOWS_FIX = "run claudes inside the Windows Subsystem for Linux";

export interface RuntimeDeps {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly env: Env;
  /** The resolved `claude` path, or undefined when it is not on PATH. */
  readonly claudePath: string | undefined;
  readonly runProc: RunProc;
  readonly versionTimeoutMs?: number;
}

/**
 * Check 1: the runtime claudes needs — Node 22+, a `claude` on PATH at or
 * above the spike's version, and not native Windows. Pure: platform, versions
 * and the version probe are all injected.
 */
export async function checkRuntime(deps: RuntimeDeps): Promise<CheckResult[]> {
  if (deps.platform === "win32") {
    return [{ status: "FAIL", title: WINDOWS_FAIL_TITLE, fix: WINDOWS_FIX }];
  }
  const results: CheckResult[] = [nodeResult(deps.nodeVersion)];
  const claude = await claudeResults(deps);
  results.push(...claude);
  return results;
}

function nodeResult(nodeVersion: string): CheckResult {
  const parsed = parseVersionTriple(nodeVersion);
  if (parsed === undefined) {
    return {
      status: "FAIL",
      title: "could not read this process's Node version",
      fix: "reinstall Node 22 or newer and retry",
    };
  }
  const printable = printableVersion(parsed);
  if (parsed.major < MIN_NODE_MAJOR) {
    return {
      status: "FAIL",
      title: `node ${printable} is older than ${MIN_NODE_MAJOR}`,
      fix: `install Node ${MIN_NODE_MAJOR} or newer`,
    };
  }
  return { status: "PASS", title: `node ${printable}` };
}

async function claudeResults(deps: RuntimeDeps): Promise<CheckResult[]> {
  if (deps.claudePath === undefined) {
    return [
      {
        status: "FAIL",
        title: "claude not found on PATH",
        fix: "install Claude Code and make `claude` resolvable on PATH",
      },
    ];
  }
  const proc = await deps.runProc(deps.claudePath, ["--version"], {
    timeoutMs: deps.versionTimeoutMs ?? VERSION_TIMEOUT_MS,
  });
  if (proc.timedOut) {
    return [
      {
        status: "FAIL",
        title: "`claude --version` did not finish in time",
        fix: `check that ${deps.claudePath} runs at all, then retry`,
      },
    ];
  }
  if (!proc.ok) {
    return [
      {
        status: "FAIL",
        title: `could not run ${deps.claudePath} (${describeFailure(proc.code, proc.signal)})`,
        fix: "reinstall Claude Code and retry",
      },
    ];
  }
  const parsed = parseVersionTriple(proc.stdout);
  if (parsed === undefined) {
    return [
      {
        status: "FAIL",
        title: "could not read the claude version from `claude --version`",
        fix: "reinstall Claude Code and retry",
      },
    ];
  }
  const printable = printableVersion(parsed);
  if (!isSupportedClaude(parsed)) {
    return [
      {
        status: "FAIL",
        title: `claude ${printable} is older than the tested ${MIN_CLAUDE_VERSION}`,
        fix: `update Claude Code to ${MIN_CLAUDE_VERSION} or newer`,
      },
    ];
  }
  return [{ status: "PASS", title: `claude ${printable} (${deps.claudePath})` }];
}

/** "exit 7" / "killed by SIGKILL" / "did not start" — never a message body. */
function describeFailure(code: number | null, signal: string | null): string {
  if (signal !== null) {
    return `killed by ${signal}`;
  }
  if (code !== null) {
    return `exit ${code}`;
  }
  return "did not start";
}
