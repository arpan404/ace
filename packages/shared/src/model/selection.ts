import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ProviderModelOptions,
} from "@ace/contracts";

import { type SelectableModelOption } from "./types";

type ModelSelectionByProvider<TProvider extends ProviderKind> = Extract<
  ModelSelection,
  { provider: TProvider }
>;

function withoutKnownCursorVariantSuffix(value: string): string {
  let normalized = value;

  if (normalized.endsWith("-fast")) {
    normalized = normalized.substring(0, normalized.length - "-fast".length);
  }

  for (const suffix of ["-xhigh", "-high", "-medium", "-low", "-none"] as const) {
    if (normalized.endsWith(suffix)) {
      return normalized.substring(0, normalized.length - suffix.length);
    }
  }

  return normalized;
}

function normalizeCursorVariantSelectionCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = withoutKnownCursorVariantSuffix(trimmed);
  return normalized !== trimmed ? normalized : null;
}

export function buildProviderModelSelection<TProvider extends ProviderKind>(
  provider: TProvider,
  model: string,
  options?: ProviderModelOptions[TProvider],
  providerInstanceId?: string,
): ModelSelectionByProvider<TProvider> {
  return {
    provider,
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    model,
    ...(options === undefined ? {} : { options }),
  } as ModelSelectionByProvider<TProvider>;
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  if (resolved) {
    return resolved.slug;
  }

  if (provider === "cursor") {
    const canonicalCursorSlug = normalizeCursorVariantSelectionCandidate(normalized);
    if (!canonicalCursorSlug) {
      return null;
    }
    const canonicalCursorOption = options.find((option) => option.slug === canonicalCursorSlug);
    return canonicalCursorOption ? canonicalCursorOption.slug : null;
  }

  return null;
}

export function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      switch (modelSelection.options?.contextWindow) {
        case "1m":
          return `${modelSelection.model}[1m]`;
        default:
          return modelSelection.model;
      }
    }
    default:
      return modelSelection.model;
  }
}
