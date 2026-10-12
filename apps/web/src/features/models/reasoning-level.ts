/**
 * Ultra and Max: the deepest reasoning a provider names, which gets the accent sheen and the
 * animated thumb. Explicit provider capabilities, never inferred from being the last choice
 * (Extra high stays an ordinary level).
 */
export function isDeepReasoning(effort: string | undefined, supported: readonly string[]): boolean {
  return effort !== undefined && supported.includes(effort) && /^(ultra|max)$/i.test(effort);
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
