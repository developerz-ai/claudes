import { validProfileName } from "./config/profile";

/** Subcommands the launcher will own itself; everything else is passed through to `claude`. */
const RESERVED_WORDS = ["login", "doctor", "key", "profile"] as const;

export const VERSION_FLAGS = ["--version", "-v"] as const;

/** The flag that asks for help instead of running anything. */
export const HELP_FLAG = "--help";

/** The help outputs claudes has: the top level, and the commands with their own. */
export const HELP_SCOPES = ["top", "login", "doctor"] as const;

/** One help output's scope. */
export type HelpScope = (typeof HELP_SCOPES)[number];

type ReservedWord = (typeof RESERVED_WORDS)[number];

/** The flag that selects a routed session's profile when it leads argv. */
export const PROFILE_FLAG = "--profile";

export const INVALID_PROFILE_MESSAGE = "claudes: invalid --profile name";
export const MISPLACED_PROFILE_MESSAGE =
  "claudes: a leading --profile only selects a session's router; give claudes' own commands their own (claudes login|doctor|key --profile <name>, claudes profile use <name>)";
export const REPEATED_PROFILE_MESSAGE = "claudes: --profile may only be given once";

export type DispatchResult =
  | { kind: "version" }
  | { kind: "help"; scope: HelpScope }
  | { kind: "reserved"; word: ReservedWord }
  | { kind: "passthrough"; args: string[]; profile?: string }
  | { kind: "usage"; message: string };

function isReservedWord(word: string): word is ReservedWord {
  return (RESERVED_WORDS as readonly string[]).includes(word);
}

/**
 * The help scope each command answers `--help` with. `key` has none: the
 * command takes no arguments at all, so `claudes key --help` must reach the
 * command and be refused there, as the README's refusals table promises.
 */
const COMMAND_HELP_SCOPES: Readonly<Record<ReservedWord, HelpScope | undefined>> = {
  login: "login",
  doctor: "doctor",
  key: undefined,
  profile: undefined,
};

/**
 * Pure routing of argv (everything after the program name) to a decision. A
 * leading `--profile <name>` (or `--profile=<name>`) selects the profile of a
 * routed session; in front of one of claudes' own commands, the version flags
 * or `--help` it is refused rather than letting the command word reach
 * `claude` as a prompt. The name is never echoed.
 */
export function dispatch(argv: string[]): DispatchResult {
  const first = argv[0];
  if (first === PROFILE_FLAG || first?.startsWith(`${PROFILE_FLAG}=`)) {
    const inline = first !== PROFILE_FLAG;
    const name = inline ? first.slice(PROFILE_FLAG.length + 1) : argv[1];
    if (!validProfileName(name)) return { kind: "usage", message: INVALID_PROFILE_MESSAGE };
    const inner = dispatchCommand(argv.slice(inline ? 1 : 2));
    if (inner.kind !== "passthrough") return { kind: "usage", message: MISPLACED_PROFILE_MESSAGE };
    const next = inner.args[0];
    if (next === PROFILE_FLAG || next?.startsWith(`${PROFILE_FLAG}=`)) {
      return { kind: "usage", message: REPEATED_PROFILE_MESSAGE };
    }
    return { ...inner, profile: name };
  }
  return dispatchCommand(argv);
}

/** Routing once any leading --profile is consumed. */
function dispatchCommand(argv: string[]): DispatchResult {
  const first = argv[0];
  if (first !== undefined && (VERSION_FLAGS as readonly string[]).includes(first)) {
    return { kind: "version" };
  }
  // `--help` is answered when it is the command's only argument. Anything else
  // keeps the command's own handling, so the refusals that command owns — the
  // router-key refusal above all — still fire on a pasted key.
  if (first === HELP_FLAG && argv.length === 1) {
    return { kind: "help", scope: "top" };
  }
  if (first !== undefined && isReservedWord(first)) {
    if (argv.length === 2 && argv[1] === HELP_FLAG) {
      const scope = COMMAND_HELP_SCOPES[first];
      if (scope !== undefined) {
        return { kind: "help", scope };
      }
    }
    return { kind: "reserved", word: first };
  }
  return { kind: "passthrough", args: argv };
}
