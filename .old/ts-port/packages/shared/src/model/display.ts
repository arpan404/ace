import type { ProviderKind } from "@ace/contracts";

function formatCodexModelNameFromSlug(slug: string): string {
  const trimmed = slug.trim();
  const gptMatch = trimmed.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
  if (!gptMatch) {
    return trimmed;
  }

  const version = gptMatch[1];
  const suffix = gptMatch[2];
  if (!suffix) {
    return `GPT-${version}`;
  }

  const words = suffix
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => {
      switch (part.toLowerCase()) {
        case "codex":
          return "Codex";
        case "spark":
          return "Spark";
        case "mini":
          return "Mini";
        case "nano":
          return "Nano";
        case "high":
          return "High";
        case "medium":
          return "Medium";
        case "low":
          return "Low";
        case "xhigh":
          return "Extra High";
        default:
          return part.charAt(0).toUpperCase() + part.slice(1);
      }
    });

  return [`GPT-${version}`, ...words].join(" ");
}

export function formatProviderModelDisplayName(
  provider: ProviderKind,
  slug: string,
  fallbackName?: string | null,
): string {
  if (provider === "codex") {
    return formatCodexModelNameFromSlug(slug);
  }

  const trimmedFallback = fallbackName?.trim();
  return trimmedFallback && trimmedFallback.length > 0 ? trimmedFallback : slug;
}
