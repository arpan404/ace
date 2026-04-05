import { type ProviderKind } from "@ace/contracts";

import { normalizeModelSlug } from "./selection";
import { trimOrNull } from "./text";

function includesAny(value: string, candidates: ReadonlyArray<string>): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

export function inferModelContextWindowTokens(
  provider: ProviderKind,
  model: string | null | undefined,
): number | undefined {
  const normalized = normalizeModelSlug(model, provider);
  const lookupValue = (normalized ?? trimOrNull(model) ?? "").toLowerCase();
  if (!lookupValue) {
    return undefined;
  }

  switch (provider) {
    case "gemini": {
      if (
        lookupValue === "auto" ||
        lookupValue === "pro" ||
        lookupValue === "flash" ||
        lookupValue === "flash-lite" ||
        lookupValue.startsWith("auto-gemini-") ||
        lookupValue.startsWith("gemini-2.5-") ||
        lookupValue.startsWith("gemini-3")
      ) {
        return 1_048_576;
      }
      return undefined;
    }
    case "cursor": {
      if (includesAny(lookupValue, ["composer-2", "composer 2"])) {
        return 200_000;
      }
      if (
        includesAny(lookupValue, [
          "claude-4-sonnet",
          "claude 4 sonnet",
          "claude-sonnet-4-6",
          "claude sonnet 4.6",
          "claude-4.6-sonnet",
          "sonnet-4",
          "sonnet 4",
          "claude-opus-4-6",
          "claude opus 4.6",
          "claude-4.6-opus",
          "opus-4.6",
          "opus 4.6",
          "gemini-3.1-pro",
          "gemini 3.1 pro",
        ])
      ) {
        return 200_000;
      }
      if (
        lookupValue === "gpt-5.3-codex" ||
        lookupValue.startsWith("gpt-5.3-codex ") ||
        lookupValue === "gpt 5.3 codex" ||
        lookupValue.startsWith("gpt 5.3 codex ") ||
        lookupValue === "gpt-5.4" ||
        lookupValue.startsWith("gpt-5.4 ") ||
        lookupValue === "gpt 5.4" ||
        lookupValue.startsWith("gpt 5.4 ")
      ) {
        return 272_000;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
