import type { ModelCapabilities, ServerProviderModel } from "@ace/contracts";

const EMPTY_CODEX_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const CODEX_REASONING_LEVELS = ["xhigh", "high", "medium", "low"] as const;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toCodexReasoningLabel(value: (typeof CODEX_REASONING_LEVELS)[number]): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
  }
}

function buildCodexModelCapabilities(entry: Record<string, unknown>): ModelCapabilities {
  const supportedEfforts = new Set<(typeof CODEX_REASONING_LEVELS)[number]>();
  const supportedReasoningLevels = asArray(entry.supported_reasoning_levels) ?? [];
  for (const candidate of supportedReasoningLevels) {
    const effort = asString(asObject(candidate)?.effort);
    if (effort === "xhigh" || effort === "high" || effort === "medium" || effort === "low") {
      supportedEfforts.add(effort);
    }
  }

  const defaultReasoningLevel = asString(entry.default_reasoning_level);
  const fastTiers = asArray(entry.additional_speed_tiers) ?? [];
  const reasoningEffortLevels: Array<{
    value: string;
    label: string;
    isDefault?: boolean;
  }> = [];
  for (const value of CODEX_REASONING_LEVELS) {
    if (!supportedEfforts.has(value)) {
      continue;
    }
    const level = {
      value,
      label: toCodexReasoningLabel(value),
    };
    if (defaultReasoningLevel === value) {
      Object.assign(level, { isDefault: true });
    }
    reasoningEffortLevels.push(level);
  }

  return {
    reasoningEffortLevels,
    supportsFastMode: fastTiers.some((tier) => asString(tier) === "fast"),
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

export function parseCodexDebugModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const parsed = JSON.parse(output) as unknown;
  const record = asObject(parsed);
  const models = asArray(record?.models) ?? [];
  const result: ServerProviderModel[] = [];

  for (const candidate of models) {
    const entry = asObject(candidate);
    const slug = asString(entry?.slug)?.trim();
    if (!slug) {
      continue;
    }

    const visibility = asString(entry?.visibility)?.trim();
    if (visibility === "hide") {
      continue;
    }

    const displayName = asString(entry?.display_name)?.trim();
    result.push({
      slug,
      name: displayName && displayName.length > 0 ? displayName : slug,
      isCustom: false,
      capabilities: buildCodexModelCapabilities(entry ?? {}),
    });
  }

  return result;
}

export function getFallbackCodexModelCapabilities(
  model: string | null | undefined,
): ModelCapabilities {
  const slug = model?.trim();
  if (!slug) {
    return EMPTY_CODEX_MODEL_CAPABILITIES;
  }

  if (!slug.startsWith("gpt-")) {
    return EMPTY_CODEX_MODEL_CAPABILITIES;
  }

  const defaultReasoningLevel = slug === "gpt-5.3-codex-spark" ? "high" : "medium";
  const reasoningEffortLevels: Array<{
    value: string;
    label: string;
    isDefault?: boolean;
  }> = [];
  for (const value of CODEX_REASONING_LEVELS) {
    const level = {
      value,
      label: toCodexReasoningLabel(value),
    };
    if (defaultReasoningLevel === value) {
      Object.assign(level, { isDefault: true });
    }
    reasoningEffortLevels.push(level);
  }

  return {
    reasoningEffortLevels,
    supportsFastMode: slug === "gpt-5.4" || slug === "gpt-5.5",
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}
