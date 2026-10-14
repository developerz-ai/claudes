import { VERSION } from "./version";

/** Subcommands the launcher will own itself; everything else is passed through to `claude`. */
const RESERVED_WORDS: readonly string[] = ["login", "doctor", "key"];

export type DispatchResult =
  | { kind: "version" }
  | { kind: "reserved"; word: string }
  | { kind: "passthrough"; args: string[] };

/** Pure routing of argv (everything after the program name) to a decision. */
export function dispatch(argv: string[]): DispatchResult {
  const first = argv[0];
  if (first === "--version" || first === "-v") {
    return { kind: "version" };
  }
  if (first !== undefined && RESERVED_WORDS.includes(first)) {
    return { kind: "reserved", word: first };
  }
  return { kind: "passthrough", args: argv };
}

function main(argv: string[]): never {
  const result = dispatch(argv);
  if (result.kind === "version") {
    console.log(VERSION);
    process.exit(0);
  }
  if (result.kind === "reserved") {
    console.error(`claudes ${result.word}: not implemented yet`);
    process.exit(64);
  }
  console.error("claudes: launcher not implemented yet");
  process.exit(64);
}

if (process.argv[1] && import.meta.main) {
  main(process.argv.slice(2));
}
