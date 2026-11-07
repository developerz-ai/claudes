/** Subcommands the launcher will own itself; everything else is passed through to `claude`. */
const RESERVED_WORDS = ["login", "doctor", "key"] as const;

export const VERSION_FLAGS = ["--version", "-v"] as const;

/** The flag that asks for help instead of running anything. */
export const HELP_FLAG = "--help";

/** The help outputs claudes has: the top level, and the commands with their own. */
export const HELP_SCOPES = ["top", "login", "doctor"] as const;

/** One help output's scope. */
export type HelpScope = (typeof HELP_SCOPES)[number];

type ReservedWord = (typeof RESERVED_WORDS)[number];

export type DispatchResult =
  | { kind: "version" }
  | { kind: "help"; scope: HelpScope }
  | { kind: "reserved"; word: ReservedWord }
  | { kind: "passthrough"; args: string[] };

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
};

/** Pure routing of argv (everything after the program name) to a decision. */
export function dispatch(argv: string[]): DispatchResult {
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
