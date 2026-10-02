import { CatalogModel } from "@ace/protocol";
import {
  AcpSession,
  ClaudeModels,
  CodexPage,
  ConfigOption,
  SelectConfigOption,
  isModelConfig,
  isSelectConfig,
} from "./native-schemas.ts";
import { rawPayload } from "./raw.ts";
import type { ModelInstance } from "./types.ts";
import { z } from "zod";
import { base } from "./model.ts";
import { OpenCodeParser } from "./open-code.ts";

export function normalizeCodex(payload: unknown, instance: ModelInstance): CatalogModel[] {
  return CodexPage.parse(payload).data.map((native) =>
    CatalogModel.parse({
      ...base(instance, native.model, native.displayName, native),
      isDefault: native.isDefault,
      hidden: native.hidden,
      deprecated: native.deprecated,
      contextWindow: native.contextWindow,
      reasoningEfforts: native.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      defaultEffort: native.defaultReasoningEffort,
      defaultTier: native.defaultServiceTier ?? undefined,
      serviceTiers: native.serviceTiers.length
        ? native.serviceTiers.map((tier) => ({
            id: tier.id,
            name: tier.name,
            ...(tier.id === "priority" ? { speed: "fast" } : {}),
            parameters: { serviceTier: tier.id },
          }))
        : native.additionalSpeedTiers.map((id) => ({
            id,
            name: id,
            parameters: { serviceTier: id },
          })),
      inputModalities: native.inputModalities,
    }),
  );
}
export function normalizeClaude(payload: unknown, instance: ModelInstance): CatalogModel[] {
  return ClaudeModels.parse(payload).models.map((native) =>
    CatalogModel.parse({
      ...base(instance, native.value, native.displayName, native),
      resolvedModelId: native.resolvedModel,
      contextWindow: native.contextWindow,
      reasoningEfforts: native.supportedEffortLevels,
      inputModalities: native.inputModalities,
      isDefault: native.isDefault ?? native.value === "default",
      deprecated: native.deprecated,
      serviceTiers: native.supportsFastMode
        ? [{ id: "fast", name: "Fast", speed: "fast", parameters: { fastMode: true } }]
        : [],
    }),
  );
}
function options(config: z.infer<typeof SelectConfigOption>) {
  return (config.options ?? []).flatMap((option) =>
    "options" in option
      ? z
          .array(z.object({ value: z.string(), name: z.string() }).passthrough())
          .parse(option.options)
      : [option],
  );
}
function applyConfig(model: CatalogModel, configs: z.infer<typeof ConfigOption>[]): CatalogModel {
  for (const config of configs) {
    if (!isSelectConfig(config)) continue;
    const values = options(config);
    if (config.category === "thought_level" || config.id === "reasoning_effort") {
      model.reasoningEfforts = values.map((value) => value.value);
      if (config.currentValue !== undefined) model.defaultEffort = config.currentValue;
    }
    if (config.id === "fast" && values.some((option) => option.value === "true")) {
      model.serviceTiers = [
        {
          id: "fast",
          name: values.find((option) => option.value === "true")?.name ?? "Fast",
          speed: "fast",
          parameters: { [config.id]: "true" },
        },
      ];
      if (config.currentValue === "true") model.defaultTier = "fast";
    }
    if (config.id === "context" && config.currentValue) {
      const match = /^(\d+)(k|m)?$/i.exec(config.currentValue);
      if (match?.[1])
        model.contextWindow =
          Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1000 : 1);
    }
  }
  return CatalogModel.parse(model);
}
export function normalizeAcp(payload: unknown, instance: ModelInstance): CatalogModel[] {
  const session = AcpSession.parse(payload);
  const modelConfig = session.configOptions?.find(isModelConfig);
  const current = modelConfig?.currentValue ?? session.models?.currentModelId;
  const rows = modelConfig
    ? options(modelConfig).map((option) => ({
        modelId: option.value,
        name: option.name,
        native: option,
      }))
    : (session.models?.availableModels ?? []).map((option) => ({
        modelId: option.modelId,
        name: option.name,
        native: option,
      }));
  if (rows.length > 512) throw new Error("Too many models");
  const sessionConfigs = session.configOptions ?? [];
  const sessionExtensions = sessionConfigs.filter((config) => !isSelectConfig(config));
  const representative = Math.max(
    0,
    rows.findIndex((row) => row.modelId === current),
  );
  return rows.map((row, index) => {
    const model = base(instance, row.modelId, row.name, row.native);
    model.isDefault = row.modelId === current;
    const perModel = z
      .object({ configOptions: z.array(ConfigOption).max(64).optional() })
      .parse(row.native).configOptions;
    const configs = perModel ?? (model.isDefault ? sessionConfigs : []);
    // Metadata association does not imply model support. Preserve session extensions once,
    // even when per-model configs override semantics or no listed model is current.
    model.raw = rawPayload({
      ...row.native,
      configOptions: configs,
      ...(index === representative && configs !== sessionConfigs && sessionExtensions.length
        ? { sessionConfigOptions: sessionExtensions }
        : {}),
    });
    return applyConfig(model, configs);
  });
}
/** Convenience for callers that already hold a bounded CLI transcript. */
export function normalizeOpenCode(output: string, instance: ModelInstance): CatalogModel[] {
  const parser = new OpenCodeParser(instance);
  let start = 0;
  for (let end = 0; end < output.length; end++) {
    if (output[end] !== "\n") continue;
    parser.push(output.slice(start, end).replace(/\r$/, ""));
    start = end + 1;
  }
  if (start < output.length) parser.push(output.slice(start).replace(/\r$/, ""));
  return parser.finish();
}
