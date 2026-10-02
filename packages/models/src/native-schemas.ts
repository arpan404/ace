import { z } from "zod";
const id = z.string().min(1).max(256);
const efforts = z.array(id).max(32);
export const CodexPage = z
  .object({
    data: z
      .array(
        z
          .object({
            id,
            model: id,
            displayName: id,
            isDefault: z.boolean(),
            hidden: z.boolean().default(false),
            deprecated: z.boolean().default(false),
            contextWindow: z.number().int().positive().optional(),
            supportedReasoningEfforts: z
              .array(z.object({ reasoningEffort: id }).passthrough())
              .max(32),
            defaultReasoningEffort: id,
            serviceTiers: z
              .array(z.object({ id, name: id }).passthrough())
              .max(32)
              .default([]),
            additionalSpeedTiers: efforts.default([]),
            defaultServiceTier: id.nullish(),
            inputModalities: efforts.default([]),
          })
          .passthrough(),
      )
      .max(512),
    nextCursor: id.nullish(),
  })
  .passthrough();
export const ClaudeModels = z
  .object({
    models: z
      .array(
        z
          .object({
            value: id,
            displayName: id,
            resolvedModel: id.optional(),
            supportedEffortLevels: efforts.default([]),
            supportsFastMode: z.boolean().optional(),
            isDefault: z.boolean().optional(),
            contextWindow: z.number().int().positive().optional(),
            inputModalities: efforts.default([]),
            deprecated: z.boolean().default(false),
          })
          .passthrough(),
      )
      .max(512),
  })
  .passthrough();
const SelectOption = z.object({ value: id, name: id }).passthrough();
export const SelectConfigOption = z
  .object({
    id,
    category: id.optional(),
    type: z.literal("select"),
    currentValue: z.string().optional(),
    options: z
      .array(
        z.union([
          SelectOption,
          z.object({ group: id, name: id, options: z.array(SelectOption).max(512) }).passthrough(),
        ]),
      )
      .max(512)
      .optional(),
  })
  .passthrough();
export const ConfigOption = z.union([
  SelectConfigOption,
  z
    .object({ id, category: id.optional(), type: z.string().refine((type) => type !== "select") })
    .passthrough(),
]);
export function isSelectConfig(
  config: z.infer<typeof ConfigOption>,
): config is z.infer<typeof SelectConfigOption> {
  return config.type === "select";
}
export function isModelConfig(
  config: z.infer<typeof ConfigOption>,
): config is z.infer<typeof SelectConfigOption> {
  return isSelectConfig(config) && (config.category === "model" || config.id === "model");
}
export const AcpSession = z
  .object({
    configOptions: z.array(ConfigOption).max(64).optional(),
    models: z
      .object({
        currentModelId: id,
        availableModels: z.array(z.object({ modelId: id, name: id }).passthrough()).max(512),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (data) => data.models !== undefined || data.configOptions?.some(isModelConfig),
    "Missing model options",
  );
export const OpenCodeModel = z
  .object({
    id,
    providerID: id,
    name: id,
    status: z.string().optional(),
    limit: z.object({ context: z.number().int().positive().optional() }).passthrough().optional(),
    capabilities: z
      .object({ input: z.record(id, z.boolean()) })
      .passthrough()
      .optional(),
    variants: z.record(id, z.object({ reasoningEffort: id.optional() }).passthrough()).default({}),
  })
  .passthrough();
