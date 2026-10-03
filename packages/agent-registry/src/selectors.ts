import { z } from "zod";
import type { CompatibilityProfile } from "./profiles.ts";
const label = z.string().min(1).max(256);
const Value = z.object({ value: label, name: label }).passthrough();
const Select = z
  .object({
    id: label,
    category: z.string().max(128).optional(),
    type: z.literal("select"),
    currentValue: z.string().max(256).optional(),
    options: z
      .array(
        z.union([
          Value,
          z.object({ group: z.string().max(256), options: z.array(Value).max(512) }).passthrough(),
        ]),
      )
      .max(512),
  })
  .passthrough();
const Setup = z
  .object({
    configOptions: z.array(z.unknown()).max(64).optional(),
    models: z
      .object({
        currentModelId: label.optional(),
        availableModels: z.array(z.object({ modelId: label, name: label }).passthrough()).max(512),
      })
      .passthrough()
      .optional(),
    modes: z
      .object({
        currentModeId: label.optional(),
        availableModes: z.array(z.object({ id: label, name: label }).passthrough()).max(128),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SelectorState = Readonly<{
  model?: {
    configId?: string;
    method: "session/set_config_option" | "session/set_model";
    values: readonly string[];
  };
  mode?: {
    configId?: string;
    method: "session/set_config_option" | "session/set_mode";
    values: readonly string[];
  };
  raw: unknown;
}>;
export function sessionSelectors(
  raw: unknown,
  profile?: CompatibilityProfile,
  legacyModel = false,
): SelectorState {
  const session = Setup.parse(raw);
  if (profile?.denySelectors) return { raw };
  let model: SelectorState["model"];
  let mode: SelectorState["mode"];
  for (const entry of session.configOptions ?? []) {
    const result = Select.safeParse(entry);
    if (!result.success) continue;
    const config = result.data;
    const values: string[] = [];
    for (const option of config.options) {
      const entries =
        "value" in option && typeof option.value === "string"
          ? [option.value]
          : "options" in option && Array.isArray(option.options)
            ? option.options.map((value) => value.value)
            : [];
      for (const value of entries) {
        if (values.length >= 512) throw new Error("Selector option budget exceeded");
        values.push(value);
      }
    }
    if (!model && (config.category === "model" || (!config.category && config.id === "model")))
      model = { method: "session/set_config_option", configId: config.id, values };
    if (!mode && (config.category === "mode" || (!config.category && config.id === "mode")))
      mode = { method: "session/set_config_option", configId: config.id, values };
  }
  if (!model && session.models && (profile?.legacyModel || legacyModel))
    model = {
      method: "session/set_model",
      values: session.models.availableModels.map((value) => value.modelId),
    };
  if (!mode && session.modes)
    mode = {
      method: "session/set_mode",
      values: session.modes.availableModes.map((value) => value.id),
    };
  return { ...(model ? { model } : {}), ...(mode ? { mode } : {}), raw };
}
export function selectorRequest(
  selectors: SelectorState,
  kind: "model" | "mode",
  value: string,
  sessionId: string,
): { method: string; params: Record<string, string> } {
  const selector = selectors[kind];
  if (!selector || !selector.values.includes(value))
    throw new Error(`ACP ${kind} selection unavailable`);
  return {
    method: selector.method,
    params: selector.configId
      ? { sessionId, configId: selector.configId, value }
      : kind === "model"
        ? { sessionId, modelId: value }
        : { sessionId, modeId: value },
  };
}
