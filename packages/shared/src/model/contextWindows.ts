import { type ProviderKind } from "@ace/contracts";

import { normalizeModelSlug } from "./selection";
import { trimOrNull } from "./text";

function includesAny(value: string, candidates: ReadonlyArray<string>): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function parseContextTokenCount(value: string): number | undefined {
  const match = value.match(/\bcontext\s*=\s*(\d+(?:\.\d+)?)\s*([km])?\b/i);
  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function matchesCursorModelVariant(value: string, baseModel: string): boolean {
  if (value === baseModel) {
    return true;
  }
  if (!value.startsWith(baseModel)) {
    return false;
  }

  const suffix = value.slice(baseModel.length);
  return (
    suffix.startsWith("[") ||
    suffix.startsWith(" ") ||
    suffix === "-fast" ||
    suffix === "-xhigh" ||
    suffix === "-high" ||
    suffix === "-medium" ||
    suffix === "-low" ||
    suffix === "-none" ||
    suffix.startsWith("-fast[") ||
    suffix.startsWith("-xhigh[") ||
    suffix.startsWith("-high[") ||
    suffix.startsWith("-medium[") ||
    suffix.startsWith("-low[") ||
    suffix.startsWith("-none[")
  );
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
      const explicitContextTokens = parseContextTokenCount(lookupValue);
      if (explicitContextTokens !== undefined) {
        return explicitContextTokens;
      }

      if (lookupValue === "auto" || lookupValue.startsWith("default[")) {
        return 200_000;
      }

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
      if (matchesCursorModelVariant(lookupValue, "gpt-5.3-codex")) {
        return 272_000;
      }
      if (matchesCursorModelVariant(lookupValue, "gpt-5.4")) {
        return 272_000;
      }
      if (lookupValue === "gpt 5.3 codex" || lookupValue.startsWith("gpt 5.3 codex ")) {
        return 272_000;
      }
      if (lookupValue === "gpt 5.4" || lookupValue.startsWith("gpt 5.4 ")) {
        return 272_000;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
