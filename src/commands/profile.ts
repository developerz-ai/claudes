import { lstatSync, unlinkSync } from "node:fs";
import { loadConfig } from "../config/load";
import { activeProfileFile, configDir, type Env, profileFile } from "../config/paths";
import { writePrivateFile } from "../config/private-file";
import { activeProfile, profileNames, validProfileName } from "../config/profile";
import { keyFragmentOffset } from "../config/schema";
import { scrub } from "../router/errors";

const USAGE = "usage: claudes profile list | use <name> | remove <name>";

export function runProfile(
  args: readonly string[],
  env: Env,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const [command, name] = args;
  const fail = (code: number, message: string): number => {
    err(`claudes profile: ${scrub(message)}`);
    return code;
  };
  if (
    !(command === "list" && args.length === 1) &&
    !((command === "use" || command === "remove") && args.length === 2 && validProfileName(name))
  ) {
    return fail(64, `invalid profile command or name\n${USAGE}`);
  }
  try {
    const dir = configDir(env);
    if (command === "list") {
      const active = activeProfile(dir);
      for (const profile of profileNames(dir)) {
        const loaded = loadConfig(env, profile);
        const origin = loaded.ok ? new URL(loaded.config.baseUrl).origin : "(unusable config)";
        const line = `${profile === active ? "*" : " "} ${profile} ${origin}`;
        out(
          loaded.ok && keyFragmentOffset(line, loaded.config.key) !== undefined
            ? "(profile details withheld)"
            : scrub(line),
        );
      }
      return 0;
    }
    if (name === undefined) return fail(64, USAGE);
    if (command === "use") {
      const loaded = loadConfig(env, name);
      if (!loaded.ok) return fail(loaded.exitCode, loaded.message);
      writePrivateFile(activeProfileFile(dir), `${name}\n`, {
        noun: "active profile",
        remedy: "check the config directory and run claudes profile use again",
      });
      out(`active profile: ${name}`);
      return 0;
    }
    if (activeProfile(dir) === name) return fail(64, "cannot remove the active profile");
    const directory = lstatSync(dir);
    const path = profileFile(dir, name);
    const file = lstatSync(path);
    const uid = process.getuid?.();
    if (
      !directory.isDirectory() ||
      !file.isFile() ||
      (uid !== undefined && (directory.uid !== uid || file.uid !== uid))
    ) {
      return fail(
        78,
        "refusing to remove a profile outside the caller-owned config directory or a non-regular file",
      );
    }
    unlinkSync(path);
    out(`removed profile: ${name}`);
    return 0;
  } catch (error) {
    return fail(78, error instanceof Error ? error.message : "could not access the profile");
  }
}
