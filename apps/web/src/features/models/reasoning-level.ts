/** Explicit provider capabilities, never inferred from being the last choice. */
export function isDeepReasoning(effort: string | undefined, supported: readonly string[]): boolean {
  return (
    effort !== undefined &&
    supported.includes(effort) &&
    /^(ultra|xhigh|extra_high|max)$/i.test(effort)
  );
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
    case "xhigh":
    case "extra_high":
    case "max":
      return "Use this model’s most extensive reasoning.";
    default:
      return "Use the selected reasoning setting reported by this model.";
  }
}

/** Compact names, without relabelling an ordinary High capability as Max. */
export function reasoningShortLabel(effort: string): string {
  const labels: Record<string, string> = {
    minimal: "Min",
    low: "Low",
    light: "Light",
    medium: "Med",
    high: "High",
    xhigh: "Max",
    extra_high: "Max",
    max: "Max",
    ultra: "Ultra",
    none: "Off",
  };
  return labels[effort.toLowerCase()] ?? effort;
}
