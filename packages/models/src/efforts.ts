import type { EffortLevel, ModelEffort } from "@ace/protocol";

/** Provider spellings of ace's effort scale. */
const synonyms: Readonly<Record<string, EffortLevel>> = {
  none: "off",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
  ultra: "ultra",
};
const labels: Readonly<Record<EffortLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
/** Boolean parameter values switch extended thinking on or off; they are not effort levels. */
const toggles = new Set(["true", "false"]);

/** The canonical level a native effort id names, or null when ace doesn't know it. */
export function effortLevel(id: string): EffortLevel | null {
  return synonyms[id.toLowerCase()] ?? null;
}

/**
 * Catalog efforts from a provider's native values, in the provider's order (weakest first):
 * the exact native id, its canonical level and a label. Thinking on/off values are dropped.
 */
export function modelEfforts(
  values: readonly (string | { id: string; label?: string | undefined })[],
): ModelEffort[] {
  const seen = new Set<string>();
  const efforts: ModelEffort[] = [];
  for (const value of values) {
    const { id, label } = typeof value === "string" ? { id: value, label: undefined } : value;
    if (!id || toggles.has(id) || seen.has(id)) continue;
    seen.add(id);
    const level = effortLevel(id);
    efforts.push({ id, level, label: label ?? (level ? labels[level] : id) });
  }
  return efforts.slice(0, 32);
}

/** Whether a parameter's values are a thinking on/off switch rather than effort levels. */
export function isThinkingToggle(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => toggles.has(value));
}

/** Pi's `--thinking` levels (pi --help, 1.2.0), offered for its reasoning models. */
export const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function piEfforts(
  reasoning: boolean,
  current: string | null | undefined,
): { efforts: ModelEffort[]; defaultEffort?: string } {
  if (!reasoning) return { efforts: [] };
  const efforts = modelEfforts(piThinkingLevels);
  const defaultEffort = listedEffort(efforts, current);
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}

/** A native default, kept only when the model lists it. */
export function listedEffort(
  efforts: readonly ModelEffort[],
  id: string | null | undefined,
): string | undefined {
  return id != null && efforts.some((effort) => effort.id === id) ? id : undefined;
}
