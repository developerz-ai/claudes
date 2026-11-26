import type { Config } from "../config/schema";
import type { ModelEntry } from "../router/client";
import {
  DEFAULT_TIERS,
  type ModelFamily,
  parseTierId,
  TIER_FAMILIES,
  type TierName,
} from "../tiers";

export interface PickerOption {
  readonly model: string;
  readonly label: string;
  readonly description?: string;
}

export interface Catalog {
  readonly available: boolean;
  readonly tiers: Config["tiers"];
  readonly picker: readonly PickerOption[];
  readonly entries: ReadonlyMap<string, ModelEntry>;
  readonly notes: readonly string[];
}

const FAMILIES: readonly ModelFamily[] = [...TIER_FAMILIES, "fable"];

function compareEntries(a: ModelEntry, b: ModelEntry): number {
  const left = parseTierId(a.id);
  const right = parseTierId(b.id);
  if (left !== undefined && right !== undefined) {
    return (
      right.major - left.major ||
      right.minor - left.minor ||
      right.date - left.date ||
      a.id.localeCompare(b.id)
    );
  }
  if (left !== undefined) return -1;
  if (right !== undefined) return 1;
  return a.id.localeCompare(b.id);
}

function tokenLabel(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

function pickerRow(entry: ModelEntry): PickerOption {
  const sizes = [
    entry.contextTokens === undefined ? undefined : `${tokenLabel(entry.contextTokens)} context`,
    entry.maxOutputTokens === undefined ? undefined : `${tokenLabel(entry.maxOutputTokens)} output`,
  ].filter((size) => size !== undefined);
  return {
    model: entry.id,
    label: entry.displayName ?? entry.id,
    ...(sizes.length === 0 ? {} : { description: sizes.join(" · ") }),
  };
}

export function resolveCatalog(config: Config, rows?: readonly ModelEntry[]): Catalog {
  const entries = new Map(rows?.map((entry) => [entry.id, entry]));
  const pins = config.pins ?? config.tiers;
  const notes: string[] = [];
  if (config.pins === undefined) {
    notes.push("legacy tier pins are active; re-login to follow the router catalog");
  }
  if (entries.size === 0) {
    notes.push("the model list is not live; using the stored tier snapshot");
    return {
      available: rows !== undefined,
      entries,
      picker: [],
      notes,
      tiers: { ...DEFAULT_TIERS, ...config.tiers, ...pins },
    };
  }

  const ordered = [...entries.values()].sort(compareEntries);
  const visible = ordered.filter(
    (entry) =>
      entry.resolvedModel === undefined ||
      entry.resolvedModel === entry.id ||
      !entries.has(entry.resolvedModel),
  );
  const candidates = visible.length === 0 ? ordered : visible;
  const byFamily = new Map<ModelFamily, string>();
  for (const entry of ordered) {
    const family = parseTierId(entry.id)?.family;
    if (family !== undefined && !byFamily.has(family)) byFamily.set(family, entry.id);
  }
  const preferred = new Set<string>();
  for (const family of FAMILIES) {
    const pin = pins[family];
    if (pin === undefined) continue;
    if (entries.has(pin)) {
      byFamily.set(family, pin);
      const target = entries.get(pin)?.resolvedModel;
      preferred.add(target !== undefined && entries.has(target) ? target : pin);
    } else {
      notes.push(`the ${family} pin is not served; choosing a model from the live catalog`);
    }
  }
  const picker = [
    ...candidates.filter((entry) => preferred.has(entry.id)),
    ...candidates.filter((entry) => !preferred.has(entry.id)),
  ].map(pickerRow);
  const fallback =
    TIER_FAMILIES.map((family) => byFamily.get(family)).find((id) => id !== undefined) ??
    byFamily.get("fable") ??
    picker[0]?.model;
  if (fallback === undefined) throw new Error("live catalog has no usable model");
  const familyModel = (family: TierName): string => {
    const id = byFamily.get(family);
    if (id !== undefined) return id;
    notes.push(`the router lists no ${family} tier; using another served model`);
    return fallback;
  };
  const tiers: Config["tiers"] = {
    opus: familyModel("opus"),
    sonnet: familyModel("sonnet"),
    haiku: familyModel("haiku"),
    ...(byFamily.has("fable") ? { fable: byFamily.get("fable") } : {}),
  };
  return { available: true, entries, picker, tiers, notes };
}
