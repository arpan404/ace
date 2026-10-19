import { effortLabel } from "@ace/ui-core";

/** `effort` is one the model supports and its name matches `names`. */
const supportedAs = (effort: string | undefined, supported: readonly string[], names: RegExp) =>
  effort !== undefined && supported.includes(effort) && names.test(effort);

/**
 * Ultra, ultrathink and Max: the deepest reasoning a provider names, which gets the accent
 * sheen and the glowing thumb. Explicit provider capabilities, never inferred from being the
 * last choice (Extra high stays an ordinary level).
 */
export function isDeepReasoning(effort: string | undefined, supported: readonly string[]): boolean {
  return supportedAs(effort, supported, /^(ultra|ultrathink|max)$/i);
}

/** Only Ultra and ultrathink carry the ace mark on the thumb; Max glows without it. */
export function showsAceMark(effort: string | undefined, supported: readonly string[]): boolean {
  return supportedAs(effort, supported, /^(ultra|ultrathink)$/i);
}

export function reasoningDescription(effort: string | undefined): string {
  if (!effort) return "No reasoning level has been reported. Choose a supported level to set it.";
  switch (effort.toLowerCase()) {
    case "minimal":
    case "none":
      return "Keep reasoning brief for straightforward tasks.";
    case "light":
    case "low":
      return "Light reasoning for small, focused changes.";
    case "medium":
      return "Balance depth with responsiveness.";
    case "high":
      return "Spend more reasoning on complex problems.";
    case "ultra":
    case "ultrathink":
    case "xhigh":
    case "extra_high":
    case "max":
      return "Use this model’s most extensive reasoning.";
    default:
      return "Use the selected reasoning setting reported by this model.";
  }
}

/** A short name for a compact chip ("Med"), without relabelling an ordinary High as Max. */
export function reasoningShortLabel(effort: string): string {
  const labels: Record<string, string> = {
    minimal: "Min",
    medium: "Med",
    xhigh: "X-High",
    extra_high: "X-High",
  };
  return labels[effort.toLowerCase()] ?? effortLabel(effort);
}
