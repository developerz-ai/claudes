import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../config/paths";
import type { Config } from "../config/schema";
import { type ModelFamily, parseTierId } from "../tiers";
import type { Catalog } from "./catalog";
import { inheritedWindow, WINDOW_MARKER, WINDOW_VARS } from "./env";

const ALIASES = new Map<string, ModelFamily>([
  ["opus", "opus"],
  ["claude-opus", "opus"],
  ["sonnet", "sonnet"],
  ["claude-sonnet", "sonnet"],
  ["haiku", "haiku"],
  ["claude-haiku", "haiku"],
  ["fable", "fable"],
  ["claude-fable", "fable"],
] as const);

function bare(name: string): string {
  return name.endsWith("[1m]") ? name.slice(0, -4) : name;
}

function resolveModel(name: string, catalog: Catalog): string | undefined {
  const id = bare(name);
  if (id === "default") return catalog.tiers.opus;
  const alias = ALIASES.get(id);
  if (alias !== undefined) return catalog.tiers[alias];
  if (catalog.entries.has(name)) return name;
  return catalog.entries.has(id) ? id : undefined;
}

export function readSavedModel(env: Env): string | undefined {
  const root =
    env.CLAUDE_CONFIG_DIR || (env.HOME?.startsWith("/") ? join(env.HOME, ".claude") : undefined);
  if (root === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(join(root, "settings.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 2 ** 20) return undefined;
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size !== info.size) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8", 0, size));
    const value = (parsed as { model?: unknown } | null)?.model;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function explicitModel(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (const [index, arg] of args.entries()) {
    if (arg === "--") break;
    if (arg === "--model") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("--")) model = value;
    } else if (arg.startsWith("--model=")) model = arg.slice(8);
  }
  return model;
}

export interface SessionModel {
  readonly model?: string;
  readonly launchId?: string;
  readonly window?: {
    readonly tokens: number;
    readonly source: "shell" | "profile override" | "router catalog";
  };
  readonly env: Readonly<Record<string, string>>;
  readonly notes: readonly string[];
}

export function sessionModel(
  config: Config,
  catalog: Catalog,
  parentEnv: Env,
  saved: string | undefined,
  explicit: string | undefined,
): SessionModel {
  const notes: string[] = [];
  const live = catalog.entries.size > 0;
  const savedId = saved === undefined ? undefined : resolveModel(saved, catalog);
  const explicitId = explicit === undefined ? undefined : resolveModel(explicit, catalog);
  const invalidSaved = live && saved !== undefined && savedId === undefined;
  if (explicit === undefined && invalidSaved)
    notes.push("the saved model is not served; starting on the opus tier");
  if (explicit !== undefined && live && explicitId === undefined)
    notes.push("the requested --model is not in the live catalog; passing it through");
  const launchId = explicit !== undefined ? explicitId : (savedId ?? catalog.tiers.opus);
  const entry = launchId === undefined ? undefined : catalog.entries.get(launchId);
  const target =
    entry?.resolvedModel === undefined ? undefined : catalog.entries.get(entry.resolvedModel);
  const window = config.maxContextTokens ?? entry?.contextTokens ?? target?.contextTokens;
  let maxWindow = window;
  if (
    config.maxContextTokens === undefined &&
    window !== undefined &&
    launchId !== undefined &&
    parseTierId(launchId) !== undefined
  ) {
    let smallestCustom: number | undefined;
    for (const model of catalog.entries.values()) {
      if (parseTierId(model.id) === undefined && model.contextTokens !== undefined) {
        smallestCustom = Math.min(smallestCustom ?? model.contextTokens, model.contextTokens);
      }
    }
    maxWindow = smallestCustom ?? window;
  }

  const env: Record<string, string> = { ANTHROPIC_MODEL: "" };
  const generated: string[] = [];
  for (const [index, name] of WINDOW_VARS.entries()) {
    const inherited = inheritedWindow(parentEnv, name);
    const value = index === 0 ? window : maxWindow;
    if (inherited !== undefined && inherited !== "") env[name] = inherited;
    else if (value !== undefined) {
      env[name] = String(value);
      generated.push(name);
    }
  }
  env[WINDOW_MARKER] = generated.join(",");
  const windowName =
    launchId !== undefined && parseTierId(launchId) !== undefined ? WINDOW_VARS[0] : WINDOW_VARS[1];
  const tokens = Number(env[windowName]);
  const source = !generated.includes(windowName)
    ? "shell"
    : config.maxContextTokens === undefined
      ? "router catalog"
      : "profile override";
  return {
    model: explicit === undefined && invalidSaved ? "opus" : undefined,
    launchId,
    window: Number.isSafeInteger(tokens) && tokens > 0 ? { tokens, source } : undefined,
    env,
    notes,
  };
}
