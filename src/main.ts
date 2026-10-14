import { dispatch } from "./dispatch";
import { VERSION } from "./version";

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

main(process.argv.slice(2));
