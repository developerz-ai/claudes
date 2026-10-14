/** Subcommands the launcher will own itself; everything else is passed through to `claude`. */
const RESERVED_WORDS = ["login", "doctor", "key"] as const;

type ReservedWord = (typeof RESERVED_WORDS)[number];

export type DispatchResult =
  | { kind: "version" }
  | { kind: "reserved"; word: ReservedWord }
  | { kind: "passthrough"; args: string[] };

function isReservedWord(word: string): word is ReservedWord {
  return (RESERVED_WORDS as readonly string[]).includes(word);
}

/** Pure routing of argv (everything after the program name) to a decision. */
export function dispatch(argv: string[]): DispatchResult {
  const first = argv[0];
  if (first === "--version" || first === "-v") {
    return { kind: "version" };
  }
  if (first !== undefined && isReservedWord(first)) {
    return { kind: "reserved", word: first };
  }
  return { kind: "passthrough", args: argv };
}
