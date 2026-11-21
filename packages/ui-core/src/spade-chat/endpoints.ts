import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";
import {
  spadeCantRunBots,
  spadeChecksOf,
  spadeKnownGoodOf,
  type SpadeKnownGood,
  type SpadeModelChecks,
} from "./model-checks.ts";

/*
 * The person's model endpoints and their models (ADR 0126), as `GET /v1/models` and the endpoint
 * routes write them. Parsed leniently: an endpoint or model this client can't read is left out,
 * and a field it doesn't know stays in `raw`. Keys never come back, only whether one is set.
 */

export const spadeFormats = ["openai-chat", "openai-responses", "anthropic"] as const;
export type SpadeFormat = (typeof spadeFormats)[number];

export const spadeFormatNames: Record<SpadeFormat, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
};

/** One model an endpoint serves, as Spade or the endpoint describes it. */
export interface SpadeModelInfo {
  id: string;
  name: string;
  /** Context size in tokens, when known. */
  context: number | undefined;
  /** What it can take or do beyond text ("images", "tools", "reasoning"), when known. */
  capabilities: string[];
  /** `listed`: from the endpoint's list; `typed`: the person's; `preset`: the shipped file's. */
  source: "listed" | "typed" | "preset" | undefined;
  /** On this computer: what Spade's checks found (ADR 0205 §3). */
  checks?: SpadeModelChecks | undefined;
  /** On this computer: the family ace measured it in, if it did. */
  knownGood?: SpadeKnownGood | undefined;
}

export interface SpadeEndpoint {
  id: string;
  name: string;
  format: SpadeFormat | undefined;
  baseUrl: string;
  sessionHeader: string | undefined;
  /** Names of the extra headers it sends; their values stay with Spade. */
  headerNames: string[];
  needsKey: boolean;
  /** It runs on this computer (a local model server): offered before any other (ADR 0205). */
  local: boolean;
  /** Undefined while the keychain hasn't answered (a prompt is open): not known yet. */
  keySet: boolean | undefined;
  /**
   * Where the key in use comes from: only a keychain key can be removed from here. Undefined
   * with no key, or while the keychain hasn't answered.
   */
  keySource: "keychain" | "environment" | undefined;
  /** The models the person saved or the preset knows. */
  models: SpadeModelInfo[];
  raw: Record<string, unknown>;
}

/** An endpoint template the person can add from. */
export interface SpadePreset {
  id: string;
  name: string;
  format: SpadeFormat | undefined;
  baseUrl: string;
  /** The environment variable Spade also reads its key from. */
  keyEnv: string | undefined;
  sessionHeader: string | undefined;
}

/** `GET /v1/models`. */
export interface SpadeModels {
  /** Absent on servers predating character faces. */
  characterAvatars?: boolean;
  endpoints: SpadeEndpoint[];
  presets: SpadePreset[];
  /** `endpoint/model` for titles and other small jobs; undefined: each agent's own. */
  fastModel: string | undefined;
  /** `endpoint/model` that turns recordings into words (ADR 0134); undefined: none set. */
  transcriptionModel: string | undefined;
  /** `endpoint/model` that reads replies aloud (ADR 0134, amended); undefined: none set. */
  speechModel: string | undefined;
  /** `endpoint/model` a new bot starts on; undefined: the person's first usable model. */
  newBotModel: string | undefined;
  /** False only when Spade says this machine has no keychain to keep keys in. */
  keychain: boolean;
  /** Some keys aren't known yet: the keychain hasn't answered. Asked again, they may be. */
  keysPending: boolean;
}

const optionalText = z.string().nullish().catch(undefined);
const format = z.enum(spadeFormats).nullish().catch(undefined);

/** Capabilities as a list of names, or an object of flags; anything else is unknown. */
function capabilitiesOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  const record = spadeRecord(raw);
  if (!record) return [];
  return Object.entries(record).flatMap(([name, on]) => (on === true ? [name] : []));
}

const modelShape = z.object({
  id: z.string().min(1),
  name: optionalText,
  context: z.number().int().positive().nullish().catch(undefined),
  capabilities: z.unknown().optional(),
  source: z.enum(["listed", "typed", "preset"]).nullish().catch(undefined),
  probes: z.unknown().optional(),
  known_good: z.unknown().optional(),
});

function modelOf(raw: unknown): SpadeModelInfo | undefined {
  const parsed = modelShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const model = parsed.data;
  return {
    id: model.id,
    name: model.name || model.id,
    context: model.context ?? undefined,
    capabilities: capabilitiesOf(model.capabilities),
    source: model.source ?? undefined,
    ...(spadeChecksOf(model.probes) ? { checks: spadeChecksOf(model.probes) } : {}),
    ...(spadeKnownGoodOf(model.known_good)
      ? { knownGood: spadeKnownGoodOf(model.known_good) }
      : {}),
  };
}

function modelsOf(raw: unknown): SpadeModelInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const model = modelOf(item);
    return model ? [model] : [];
  });
}

const endpointShape = z.object({
  id: z.string().min(1),
  name: optionalText,
  format,
  base_url: z.string().catch(""),
  session_header: optionalText,
  header_names: z.array(z.string()).catch([]).default([]),
  needs_key: z.boolean().catch(false).default(false),
  local: z.boolean().catch(false).default(false),
  // Null while the keychain hasn't answered; missing (an older Spade) reads as no key.
  key_set: z.boolean().nullable().catch(false).default(false),
  key_source: optionalText,
  models: z.unknown().optional(),
});

/** One endpoint value; undefined without an id. */
export function parseSpadeEndpointValue(raw: unknown): SpadeEndpoint | undefined {
  const parsed = endpointShape.safeParse(raw);
  const record = spadeRecord(raw);
  if (!parsed.success || !record) return undefined;
  const endpoint = parsed.data;
  return {
    id: endpoint.id,
    name: endpoint.name || endpoint.id,
    format: endpoint.format ?? undefined,
    baseUrl: endpoint.base_url,
    sessionHeader: endpoint.session_header || undefined,
    headerNames: endpoint.header_names,
    needsKey: endpoint.needs_key,
    local: endpoint.local,
    keySet: endpoint.key_set ?? undefined,
    keySource:
      endpoint.key_source === "keychain" || endpoint.key_source === "environment"
        ? endpoint.key_source
        : undefined,
    models: modelsOf(endpoint.models),
    raw: record,
  };
}

const presetShape = z.object({
  id: z.string().min(1),
  name: optionalText,
  format,
  base_url: z.string().catch(""),
  key_env: optionalText,
  session_header: optionalText,
});

function presetOf(raw: unknown): SpadePreset | undefined {
  const parsed = presetShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const preset = parsed.data;
  return {
    id: preset.id,
    name: preset.name || preset.id,
    format: preset.format ?? undefined,
    baseUrl: preset.base_url,
    keyEnv: preset.key_env || undefined,
    sessionHeader: preset.session_header || undefined,
  };
}

function listOf<T>(raw: unknown, read: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const value = read(item);
    return value === undefined ? [] : [value];
  });
}

/** `GET /v1/models`; undefined when the body isn't an object. */
export function parseSpadeModels(body: string): SpadeModels | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record) return undefined;
  return {
    characterAvatars: record.character_avatars === true,
    endpoints: listOf(record.endpoints, parseSpadeEndpointValue),
    presets: listOf(record.presets, presetOf),
    fastModel:
      typeof record.fast_model === "string" && record.fast_model ? record.fast_model : undefined,
    transcriptionModel:
      typeof record.transcription_model === "string" && record.transcription_model
        ? record.transcription_model
        : undefined,
    speechModel:
      typeof record.speech_model === "string" && record.speech_model
        ? record.speech_model
        : undefined,
    newBotModel:
      typeof record.new_bot_model === "string" && record.new_bot_model
        ? record.new_bot_model
        : undefined,
    keychain: record.keychain !== false,
    keysPending: record.keys_pending === true,
  };
}

/** `{"endpoint": ...}` from adding or changing one. */
export function parseSpadeEndpoint(body: string): SpadeEndpoint | undefined {
  return parseSpadeEndpointValue(spadeRecord(spadeJson(body))?.endpoint);
}

/** `GET /v1/endpoints/{id}/models`: what the endpoint itself lists; undefined without a list. */
export function parseSpadeLiveModels(body: string): SpadeModelInfo[] | undefined {
  const list = spadeRecord(spadeJson(body))?.models;
  return Array.isArray(list) ? modelsOf(list) : undefined;
}

/**
 * The models to pick from: saved ones the endpoint's live list doesn't have (typed by the
 * person), then the live list, each with what the person saved about it (their edits win).
 * Sorted by name within each.
 */
export function mergeSpadeModels(
  saved: readonly SpadeModelInfo[],
  live: readonly SpadeModelInfo[] | undefined,
): SpadeModelInfo[] {
  const byId = new Map(saved.map((model) => [model.id, model]));
  const listed = (live ?? []).map((model): SpadeModelInfo => {
    const mine = byId.get(model.id);
    if (!mine) return model;
    const merged: SpadeModelInfo = {
      id: model.id,
      name: mine.name !== mine.id ? mine.name : model.name,
      context: mine.context ?? model.context,
      capabilities: mine.capabilities.length ? mine.capabilities : model.capabilities,
      source: mine.source,
    };
    // What Spade measured about it on this computer is the saved model's (ADR 0205 §3).
    if (mine.checks) merged.checks = mine.checks;
    if (mine.knownGood) merged.knownGood = mine.knownGood;
    return merged;
  });
  const seen = new Set(listed.map((model) => model.id));
  const rest = saved.filter((model) => !seen.has(model.id));
  const byName = (a: SpadeModelInfo, b: SpadeModelInfo) => a.name.localeCompare(b.name);
  return [...rest.toSorted(byName), ...listed.toSorted(byName)];
}

/** Context and capabilities in a few words: "200K context · images, tools". */
export function spadeModelFacts(model: Pick<SpadeModelInfo, "context" | "capabilities">): string {
  const parts: string[] = [];
  if (model.context) parts.push(`${tokens(model.context)} context`);
  if (model.capabilities.length) parts.push(model.capabilities.join(", "));
  return parts.join(" · ");
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`;
  if (count >= 1_000) return `${trim(count / 1_000)}K`;
  return String(count);
}

const trim = (value: number) => String(Math.round(value * 10) / 10);

/**
 * The person's endpoints in the order Spade offers them: those `local` says run on this computer
 * first, the rest after, each in the person's order (ADR 0205 §1).
 */
export function spadeLocalFirst<T>(items: readonly T[], local: (item: T) => boolean): T[] {
  return [...items.filter((each) => local(each)), ...items.filter((each) => !local(each))];
}

/**
 * The model Spade gives a new bot when the person chose none: the first model of the first
 * endpoint that can be used now, local ones first, as `endpoint/model`. Undefined when there is
 * none: Spade then gives no model rather than one the person hasn't set up. Never a subscription.
 */
export function spadeFirstUsableModel(endpoints: readonly SpadeEndpoint[]): string | undefined {
  for (const endpoint of spadeLocalFirst(endpoints, (each) => each.local)) {
    if (endpoint.needsKey && !endpoint.keySet) continue;
    // Only a model that can run a bot: one whose checks found it calls tools (ADR 0205 §3).
    const model = endpoint.models.find((each) => !spadeCantRunBots(each));
    if (model) return `${endpoint.id}/${model.id}`;
  }
  return undefined;
}

/**
 * Whether a bot's model (`endpoint/model`, or a subscription's `cli:…`) can answer now: `ready`;
 * `none` when no model is chosen, its endpoint is gone, or the endpoint has no key; `checking`
 * while its key isn't known yet (the keychain hasn't answered). A subscription's model is its
 * CLI's to answer for.
 */
export function spadeModelState(
  model: string,
  endpoints: readonly SpadeEndpoint[],
): "ready" | "none" | "checking" {
  const chosen = model.trim();
  if (!chosen) return "none";
  if (chosen.startsWith("cli:")) return "ready";
  const id = chosen.slice(0, Math.max(0, chosen.indexOf("/")));
  const endpoint = endpoints.find((each) => each.id === id);
  if (!endpoint) return "none";
  if (!endpoint.needsKey || endpoint.keySet === true) return "ready";
  return endpoint.keySet === undefined ? "checking" : "none";
}

/**
 * Presets as a first choice offers them: by the service's plain name, without the wire format a
 * preset is written in ("Google Gemini (OpenAI format)" reads "Google Gemini"), and once per
 * service: a second format of the same one (for other models it serves) stays in Settings.
 */
export function spadePresetChoices(
  presets: readonly SpadePreset[],
): { preset: SpadePreset; label: string }[] {
  const seen = new Set<string>();
  return presets.flatMap((preset) => {
    const label = preset.name.replace(/\s*\([^()]*\bformat\)\s*$/i, "").trim() || preset.name;
    if (seen.has(label.toLowerCase())) return [];
    seen.add(label.toLowerCase());
    return [{ preset, label }];
  });
}

/**
 * A name for a server the person added by its address: "Local server" on this computer, else its
 * host ("models.example.com"). Undefined for an address that isn't one.
 */
export function spadeServerName(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return "Local server";
  return host || undefined;
}

/** Whether any endpoint can be used now: it needs no key, or has one. */
export function spadeHasUsableEndpoint(endpoints: readonly SpadeEndpoint[]): boolean {
  return endpoints.some((endpoint) => !endpoint.needsKey || endpoint.keySet);
}
