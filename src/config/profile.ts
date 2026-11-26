import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { activeProfileFile, type Env } from "./paths";

export const DEFAULT_PROFILE = "default";
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validProfileName(name: string | undefined): name is string {
  return name !== undefined && PROFILE_NAME_PATTERN.test(name);
}

/** Reads the user-owned marker. Absence selects the legacy profile. */
export function activeProfile(dir: string): string {
  const path = activeProfileFile(dir);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return DEFAULT_PROFILE;
    throw new Error("cannot read the active profile; run `claudes profile use <name>`");
  }
  try {
    const info = fstatSync(fd);
    const uid = process.getuid?.();
    if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      throw new Error("unsafe active profile file; run `claudes profile use <name>`");
    }
    const buffer = Buffer.alloc(34);
    const length = readSync(fd, buffer);
    const name = buffer.toString("utf8", 0, length).replace(/\n$/, "");
    if (info.size !== length || !validProfileName(name)) {
      throw new Error("invalid active profile file; run `claudes profile use <name>`");
    }
    return name;
  } finally {
    closeSync(fd);
  }
}

export function selectProfile(dir: string, env: Env, explicit?: string): string {
  const name = explicit ?? env.CLAUDES_PROFILE;
  if (name === undefined) return activeProfile(dir);
  if (!validProfileName(name)) {
    throw new Error(explicit === undefined ? "invalid CLAUDES_PROFILE" : "invalid --profile name");
  }
  return name;
}

/** Lists regular, private, caller-owned config files without reading credentials. */
export function profileNames(dir: string): string[] {
  let entries: string[];
  try {
    const info = lstatSync(dir);
    const uid = process.getuid?.();
    if (
      !info.isDirectory() ||
      (uid !== undefined && info.uid !== uid) ||
      (info.mode & 0o077) !== 0
    ) {
      return [];
    }
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const uid = process.getuid?.();
  return entries
    .flatMap((entry) => {
      const name =
        entry === "config.json" ? DEFAULT_PROFILE : /^config\.([a-z0-9-]+)\.json$/.exec(entry)?.[1];
      if (!validProfileName(name) || entry === "config.default.json") return [];
      try {
        const info = lstatSync(`${dir}/${entry}`);
        return info.isFile() && (uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0
          ? [name]
          : [];
      } catch {
        return [];
      }
    })
    .sort();
}
