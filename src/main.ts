import { runLogin } from "./commands/login";
import { dispatch } from "./dispatch";
import { VERSION } from "./version";

async function main(argv: string[]): Promise<void> {
  const result = dispatch(argv);
  if (result.kind === "version") {
    console.log(VERSION);
    process.exit(0);
  }
  if (result.kind === "reserved") {
    if (result.word === "login") {
      process.exit(await runLogin(argv.slice(1)));
    }
    console.error(`claudes ${result.word}: not implemented yet`);
    process.exit(64);
  }
  console.error("claudes: launcher not implemented yet");
  process.exit(64);
}

await main(process.argv.slice(2));
