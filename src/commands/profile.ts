import { lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { loadConfig } from "../config/load";
import { activeProfileFile, configDir, type Env, profileFile } from "../config/paths";
import { writePrivateFile } from "../config/private-file";
import { activeProfile, profileNames, validProfileName } from "../config/profile";
import { keyFragmentOffset } from "../config/schema";
import { removeProfileSettings } from "../launch/settings-file";
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
    const directory = lstatSync(dir);
    const uid = process.getuid?.();
    if (
      !directory.isDirectory() ||
      (uid !== undefined && directory.uid !== uid) ||
      (directory.mode & 0o077) !== 0
    ) {
      return fail(78, "profile changes require a private, caller-owned config directory");
    }
    const lock = `${dir}/.profile-lock`;
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return fail(78, "could not create the profile lock; check config directory permissions");
      }
      return fail(75, "another profile change is in progress; retry once it exits");
    }
    try {
      if (command === "use") {
        const loaded = loadConfig(env, name);
        if (!loaded.ok) return fail(loaded.exitCode, loaded.message);
        writePrivateFile(activeProfileFile(dir), `${name}\n`, {
          noun: "active profile",
          remedy: "check the config directory and run claudes profile use again",
        });
        out(
          keyFragmentOffset(name, loaded.config.key) === undefined
            ? `active profile: ${name}`
            : "active profile updated",
        );
        return 0;
      }
      if (activeProfile(dir) === name) return fail(64, "cannot remove the active profile");
      const path = profileFile(dir, name);
      const file = lstatSync(path);
      if (!file.isFile() || (uid !== undefined && file.uid !== uid)) {
        return fail(78, "refusing to remove a profile that is not a caller-owned regular file");
      }
      removeProfileSettings(dir, name);
      unlinkSync(path);
      out("profile removed");
      return 0;
    } finally {
      rmdirSync(lock);
    }
  } catch {
    return fail(78, "could not access or update the profile; check the private config directory");
  }
}
