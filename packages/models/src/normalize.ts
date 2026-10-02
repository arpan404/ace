import { CatalogModel } from "@ace/protocol";
import {
  AcpSession,
  ClaudeModels,
  CodexPage,
  ConfigOption,
  OpenCodeModel,
} from "./native-schemas.ts";
import { rawPayload } from "./raw.ts";
import type { ModelInstance } from "./types.ts";
import { z } from "zod";

function base(
  instance: ModelInstance,
  id: string,
  displayName: string,
  raw: unknown,
): CatalogModel {
  return {
    id,
    displayName,
    nativeModelId: id,
    provider: instance.provider,
    instance: instance.id,
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: [],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: rawPayload(raw),
  };
}
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
function options(config: z.infer<typeof ConfigOption>) {
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
    if (config.type !== "select") continue;
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
  const modelConfig = session.configOptions?.find(
    (option) => option.category === "model" || option.id === "model",
  );
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
  return rows.map((row) => {
    const model = base(instance, row.modelId, row.name, row.native);
    model.isDefault = row.modelId === current;
    const perModel = z
      .object({ configOptions: z.array(ConfigOption).max(64).optional() })
      .parse(row.native).configOptions;
    const configs = perModel ?? (model.isDefault ? (session.configOptions ?? []) : []);
    model.raw = rawPayload({ ...row.native, configOptions: configs });
    return applyConfig(model, configs);
  });
}
/** CLI verbose output is alternating native provider/model headings and JSON objects. */
export function normalizeOpenCode(output: string, instance: ModelInstance): CatalogModel[] {
  const rows: CatalogModel[] = [];
  let heading: string | undefined;
  let json: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!heading) {
      if (!line.trim()) continue;
      if (!/^[^\s/]+\/\S+$/.test(line.trim())) throw new Error("Malformed model heading");
      heading = line.trim();
      continue;
    }
    json.push(line);
    if (line !== "}" && !(json.length === 1 && line.startsWith("{") && line.endsWith("}")))
      continue;
    const native = OpenCodeModel.parse(JSON.parse(json.join("\n")));
    if (heading !== `${native.providerID}/${native.id}`) throw new Error("Model heading mismatch");
    const model = base(instance, heading, native.name, native);
    model.nativeProviderId = native.providerID;
    model.nativeModelId = native.id;
    if (native.limit?.context !== undefined) model.contextWindow = native.limit.context;
    model.inputModalities = Object.entries(native.capabilities?.input ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
    model.reasoningEfforts = Object.keys(native.variants);
    model.deprecated = native.status === "deprecated";
    rows.push(CatalogModel.parse(model));
    if (rows.length > 512) throw new Error("Too many models");
    heading = undefined;
    json = [];
  }
  if (heading !== undefined) throw new Error("Incomplete model metadata");
  return rows;
}
