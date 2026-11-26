import { realDoctorDeps, runDoctor } from "./commands/doctor";
import { realKeyDeps, runKey } from "./commands/key";
import { runLogin } from "./commands/login";
import { runProfile } from "./commands/profile";
import { validProfileName } from "./config/profile";
import { dispatch } from "./dispatch";
import { helpText } from "./help";
import { realRunDeps, run } from "./launch/run";
import { VERSION } from "./version";

async function main(argv: string[]): Promise<void> {
  const result = dispatch(argv);
  if (result.kind === "version") {
    console.log(VERSION);
    process.exit(0);
  }
  if (result.kind === "help") {
    console.log(helpText(result.scope));
    process.exit(0);
  }
  if (result.kind === "reserved") {
    if (result.word === "login") {
      process.exit(await runLogin(argv.slice(1)));
    }
    if (result.word === "key") {
      process.exit(runKey(argv.slice(1), realKeyDeps()));
    }
    if (result.word === "doctor") {
      process.exit(await runDoctor(argv.slice(1), realDoctorDeps()));
    }
    if (result.word === "profile") {
      process.exit(runProfile(argv.slice(1), process.env, console.log, console.error));
    }
    // Exhaustiveness guard: adding a RESERVED_WORDS member without a handler fails to compile here.
    const unhandled: never = result.word;
    throw new Error(`claudes: unhandled subcommand: ${unhandled}`);
  }
  if (result.args[0] === "--profile" || result.args[0]?.startsWith("--profile=")) {
    const name = result.args[0] === "--profile" ? result.args[1] : result.args[0].slice(10);
    if (!validProfileName(name)) {
      process.stderr.write("claudes: invalid --profile name\n");
      process.exit(64);
    }
    const start = result.args[0] === "--profile" ? 2 : 1;
    process.exit(await run(result.args.slice(start), { ...realRunDeps(), profile: name }));
  }
  process.exit(await run(result.args, realRunDeps()));
}

await main(process.argv.slice(2));
