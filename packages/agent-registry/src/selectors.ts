import { z } from "zod";
import type { CompatibilityProfile } from "./profiles.ts";
/** A selectable value is sent back exactly, so one that isn't a usable id is skipped. */
const label = z.string().min(1).max(256);
const MAX_VALUES = 512;
const MAX_CONFIG_OPTIONS = 64;
const MAX_MODES = 128;
const Select = z
  .object({
    id: label,
    category: z.string().max(128).optional().catch(undefined),
    type: z.literal("select"),
    options: z.array(z.unknown()),
  })
  .passthrough();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/**
 * The usable ids of a list (each entry's `key`), skipping entries without one. Undefined when
 * the list is longer than `max`: that selector is dropped, the rest of the setup still reads.
 */
function ids(entries: unknown[], key: string, max: number): string[] | undefined {
  if (entries.length > max) return undefined;
  return entries.flatMap((entry) => {
    const id = label.safeParse(record(entry)[key]);
    return id.success ? [id.data] : [];
  });
}
/**
 * Control, format (bidi overrides and isolates, zero-width) and line/paragraph separators. A
 * label never shows them, and a model id carrying one is skipped: ids go back to the agent
 * exactly, so they can't be cleaned, and the picker falls back to showing the id.
 */
const unsafeText = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const unsafeTextAll = new RegExp(unsafeText.source, "gu");
const safeId = (id: string) => !unsafeText.test(id);
/** `text` with every control, bidi and invisible format character removed, bounded. */
export function displayLabel(text: string): string {
  return text.replace(unsafeTextAll, "").trim().slice(0, 256);
}
export type ListedModel = Readonly<{ modelId: string; name: string }>;
/**
 * The agent's legacy `models: {availableModels, currentModelId}` list (ACP's unstable shape),
 * decoded leniently: an entry without a usable, displayable id is skipped, a duplicate keeps its
 * first name, a missing name shows the id. Undefined when absent or past the list budget: no
 * picker then, and the session carries on at the agent's default.
 */
export function listedModels(
  raw: unknown,
): { models: readonly ListedModel[]; current?: string } | undefined {
  const models = record(record(raw)["models"]);
  const entries = models["availableModels"];
  if (!Array.isArray(entries) || entries.length > MAX_VALUES) return undefined;
  const seen = new Set<string>();
  const listed: ListedModel[] = [];
  for (const entry of entries) {
    const id = label.safeParse(record(entry)["modelId"]);
    if (!id.success || !safeId(id.data) || seen.has(id.data)) continue;
    seen.add(id.data);
    const name = record(entry)["name"];
    listed.push({
      modelId: id.data,
      name: (typeof name === "string" && displayLabel(name)) || id.data,
    });
  }
  const current = label.safeParse(models["currentModelId"]);
  return { models: listed, ...(current.success ? { current: current.data } : {}) };
}
/** A select option's values, flattening groups; undefined past the value budget. */
function selectValues(options: unknown[]): string[] | undefined {
  const values: string[] = [];
  for (const option of options) {
    const entry = record(option);
    const group = Array.isArray(entry["options"]) ? entry["options"] : undefined;
    const found = group ? ids(group, "value", MAX_VALUES) : ids([option], "value", 1);
    if (!found) return undefined;
    values.push(...found);
    if (values.length > MAX_VALUES) return undefined;
  }
  return values;
}
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
  /** The session's thinking level, when the agent offers one as a config option. */
  effort?: {
    configId: string;
    method: "session/set_config_option";
    values: readonly string[];
  };
  raw: unknown;
}>;
/**
 * The selectors a session setup offers. A model is chosen through the standard `configOptions`
 * model selector when there is one, else through the legacy `models` list and
 * `session/set_model`, for every agent, profiled or not (ADR 0044's 2026-11-19 amendment).
 * `legacyModel: false` turns the legacy path off: the agent rejected `session/set_model` in
 * this session.
 */
export function sessionSelectors(
  raw: unknown,
  profile?: CompatibilityProfile,
  legacyModel = true,
): SelectorState {
  // Decoded leniently (agents send what they send): a malformed entry is skipped and an
  // oversized list drops only its own selector. The raw setup is kept as it came.
  const session = record(raw);
  if (profile?.denySelectors) return { raw };
  let model: SelectorState["model"];
  let mode: SelectorState["mode"];
  let effort: SelectorState["effort"];
  const configOptions = list(session["configOptions"]);
  for (const entry of configOptions.length > MAX_CONFIG_OPTIONS ? [] : configOptions) {
    const result = Select.safeParse(entry);
    if (!result.success) continue;
    const config = result.data;
    const values = selectValues(config.options);
    if (!values) continue;
    if (!model && (config.category === "model" || (!config.category && config.id === "model")))
      model = {
        method: "session/set_config_option",
        configId: config.id,
        values: values.filter(safeId),
      };
    if (!mode && ["mode", "permission", "permissions"].includes(config.category ?? config.id))
      mode = { method: "session/set_config_option", configId: config.id, values };
    // The same options the model catalog reads as effort levels.
    if (!effort && (config.category === "thought_level" || config.id === "reasoning_effort"))
      effort = { method: "session/set_config_option", configId: config.id, values };
  }
  const modelIds = listedModels(session)?.models.map((entry) => entry.modelId);
  const modes = record(session["modes"]);
  const modeIds = Array.isArray(modes["availableModes"])
    ? ids(modes["availableModes"], "id", MAX_MODES)
    : undefined;
  if (!model && modelIds?.length && legacyModel)
    model = { method: "session/set_model", values: modelIds };
  if (!mode && modeIds) mode = { method: "session/set_mode", values: modeIds };
  return {
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(effort ? { effort } : {}),
    raw,
  };
}
export function selectorRequest(
  selectors: SelectorState,
  kind: "model" | "mode" | "effort",
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
