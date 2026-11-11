/**
 * claudes' own help output: the top-level help, and the help of the two
 * commands that have one. The usage strings are the commands' own — imported,
 * never retyped — so the help text and the refusal a command prints cannot
 * drift apart.
 */

import { DOCTOR_FLAGS, USAGE as DOCTOR_USAGE } from "./commands/doctor";
import { LOGIN_FLAGS, USAGE as LOGIN_USAGE } from "./commands/login-args";
import { HELP_FLAG, type HelpScope, VERSION_FLAGS } from "./dispatch";

/**
 * Claude Code's own flags, which claudes passes through: it rewrites --model's
 * value and leaves -p alone. The top-level help names them, so they belong to
 * the help contract the README is checked against.
 */
export const PASSTHROUGH_FLAGS = ["--model", "-p"] as const;

/** The flags the top-level help names: claudes' own, plus the passthrough ones. */
export const HELP_FLAGS = [...VERSION_FLAGS, HELP_FLAG, ...PASSTHROUGH_FLAGS] as const;

/** The flags each help output names — the inventory its own text must match. */
export const HELP_SCOPE_FLAGS: Readonly<Record<HelpScope, readonly string[]>> = {
  top: HELP_FLAGS,
  login: LOGIN_FLAGS,
  doctor: DOCTOR_FLAGS,
};

const TOP_HELP = `usage: claudes [--version | --help] [claude arguments]

claudes runs Claude Code against your team's router, using the router key
stored by claudes login. Every argument claudes does not own is passed through
to claude, with two exceptions: a --model value is normalised to the bare tier
name when it is the long spelling of a tier (claude-opus becomes opus), and
Claude Code's own settings-file and key flags are refused rather than passed
on, as is any argument shaped like a router key.

Options:
  --version, -v    print claudes' version and exit
  --help           print this help and exit

Claude Code's own flags, passed through:
  --model <tier>   choose the tier: opus, sonnet or haiku
  -p <prompt>      run one prompt and print the answer

Commands:
  login            store your router key and the router's model tiers
  doctor           check the runtime, config, router, conflicts and wiring
  key              print the router key for Claude Code's apiKeyHelper

claudes login --help and claudes doctor --help print a command's own help.`;

const LOGIN_HELP = `${LOGIN_USAGE}

The tier overrides pin the model id used for each tier; without them claudes
picks the newest id the router advertises.`;

const DOCTOR_HELP = `${DOCTOR_USAGE}

--live also sends one live request to the router; without it doctor costs no
router quota and only asks the router for its health and model list. Doctor
exits 1 when a check FAILed.`;

/** Every help output, by scope. */
export const HELP_TEXTS: Readonly<Record<HelpScope, string>> = {
  top: TOP_HELP,
  login: LOGIN_HELP,
  doctor: DOCTOR_HELP,
};

/** The help output of a scope. */
export function helpText(scope: HelpScope): string {
  return HELP_TEXTS[scope];
}
