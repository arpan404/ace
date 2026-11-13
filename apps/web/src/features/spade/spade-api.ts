import {
  parseSpadeAgent,
  parseSpadeAgents,
  parseSpadeEndpoint,
  parseSpadeLiveModels,
  parseSpadeModels,
  parseSpadeSearchSettings,
  parseSpadeSubscriptions,
  parseSpadeTranscription,
  type SpadeAgent,
  type SpadeEndpoint,
  type SpadeFormat,
  type SpadeModelInfo,
  type SpadeModels,
  type SpadeSubscription,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's agent, endpoint and model routes (ADR 0126, 0127), each answer parsed with
 * `@ace/ui-core/spade-chat`. An answer that doesn't parse throws, in words.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

type Signal = { signal?: AbortSignal | undefined };

export async function readAgents(target: SpadeTarget, options: Signal = {}) {
  return sure(parseSpadeAgents(await spadeHttp(target, "GET", "/v1/agents", options)), "agents");
}

/**
 * An avatar as the person chose it: an image's bytes (base64 or a data: URL), or a character
 * face as stored (`storedBotFace`).
 */
export type SpadeAvatarChoice = { kind: "image"; data: string } | Record<string, unknown>;

export interface SpadeAgentDraft {
  name: string;
  task: string;
  /** `endpoint/model`. */
  model: string;
  /** Absent: Spade picks a face. */
  avatar?: SpadeAvatarChoice;
}

/**
 * A new bot. From a template (ADR 0132) the model may be left out (the template's kind picks
 * it), and its routines are made in `time_zone`, an IANA zone.
 */
export type SpadeNewAgent = Omit<SpadeAgentDraft, "model"> & {
  model?: string;
  template?: string;
  time_zone?: string;
};

export async function createAgent(target: SpadeTarget, draft: SpadeNewAgent) {
  const body = await spadeHttp(target, "POST", "/v1/agents", { body: draft });
  return sure(parseSpadeAgent(body), "new agent");
}

/** Name and avatar change at once; task and model apply from the agent's next turn. */
export async function editAgent(
  target: SpadeTarget,
  id: string,
  change: Partial<SpadeAgentDraft>,
): Promise<SpadeAgent> {
  const body = await spadeHttp(target, "PATCH", `/v1/agents/${segment(id)}`, { body: change });
  return sure(parseSpadeAgent(body), "agent");
}

/** Deletes the agent and its conversation. */
export async function deleteAgent(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/agents/${segment(id)}`);
}

/** Whether this machine's Spade hosts the main bot (only the first machine Spade ran on does). */
export async function setMainHosted(target: SpadeTarget, enabled: boolean): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/main", { body: { enabled } });
}

export async function readModels(target: SpadeTarget, options: Signal = {}): Promise<SpadeModels> {
  return sure(parseSpadeModels(await spadeHttp(target, "GET", "/v1/models", options)), "models");
}

/** The person's subscriptions a bot can think with, as ace lists them (ADR 0133). */
export async function readSubscriptions(
  target: SpadeTarget,
  options: Signal = {},
): Promise<{ providers: SpadeSubscription[]; error: string | undefined }> {
  const body = await spadeHttp(target, "GET", "/v1/subscriptions", options);
  return sure(parseSpadeSubscriptions(body), "subscriptions");
}

/** What the endpoint itself lists now. */
export async function readLiveModels(
  target: SpadeTarget,
  endpoint: string,
  options: Signal = {},
): Promise<SpadeModelInfo[]> {
  const path = `/v1/endpoints/${segment(endpoint)}/models`;
  return sure(parseSpadeLiveModels(await spadeHttp(target, "GET", path, options)), "model list");
}

export interface SpadeEndpointDraft {
  name: string;
  format: SpadeFormat;
  base_url: string;
  headers?: Record<string, string>;
  session_header?: string;
  /** False for a local server that takes no key; true when absent. */
  needs_key?: boolean;
  preset?: string;
}

export async function addEndpoint(
  target: SpadeTarget,
  draft: SpadeEndpointDraft,
): Promise<SpadeEndpoint> {
  const body = await spadeHttp(target, "POST", "/v1/endpoints", { body: draft });
  return sure(parseSpadeEndpoint(body), "new endpoint");
}

export async function editEndpoint(
  target: SpadeTarget,
  id: string,
  change: Partial<SpadeEndpointDraft>,
): Promise<SpadeEndpoint> {
  const body = await spadeHttp(target, "PATCH", `/v1/endpoints/${segment(id)}`, { body: change });
  return sure(parseSpadeEndpoint(body), "endpoint");
}

/** Refused with 409 while agents use it; the error then names them, in Spade's words. */
export async function removeEndpoint(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/endpoints/${segment(id)}`);
}

export interface SpadeModelDraft {
  id: string;
  name?: string;
  context?: number;
  capabilities?: string[];
}

/** Saves a typed or edited model on the endpoint. */
export async function saveModel(
  target: SpadeTarget,
  endpoint: string,
  model: SpadeModelDraft,
): Promise<SpadeEndpoint> {
  const path = `/v1/endpoints/${segment(endpoint)}/models`;
  return sure(
    parseSpadeEndpoint(await spadeHttp(target, "POST", path, { body: model })),
    "endpoint",
  );
}

export async function removeModel(target: SpadeTarget, endpoint: string, model: string) {
  const path = `/v1/endpoints/${segment(endpoint)}/models?id=${encodeURIComponent(model)}`;
  await spadeHttp(target, "DELETE", path);
}

/** `endpoint/model` for titles and other small jobs; null: each agent's own model. */
export async function setFastModel(target: SpadeTarget, model: string | null): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/settings", { body: { fast_model: model } });
}

export async function setKey(target: SpadeTarget, endpoint: string, key: string): Promise<void> {
  await spadeHttp(target, "PUT", `/v1/keys/${segment(endpoint)}`, { body: { key } });
}

export async function removeKey(target: SpadeTarget, endpoint: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/keys/${segment(endpoint)}`);
}

/** `endpoint/model` that turns recordings into words; null clears it (ADR 0134). */
export async function setTranscriptionModel(
  target: SpadeTarget,
  model: string | null,
): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/settings", { body: { transcription_model: model } });
}

/** A recording's words, from the transcription model's endpoint. */
export async function transcribe(
  target: SpadeTarget,
  recording: { data: string; mediaType: string },
): Promise<string> {
  const body = await spadeHttp(target, "POST", "/v1/transcriptions", {
    body: { data: recording.data, media_type: recording.mediaType },
  });
  return sure(parseSpadeTranscription(body), "transcription");
}

/** Web search's settings: the person's SearXNG address and whether a Brave key is stored. */
export async function readSearchSettings(target: SpadeTarget, options: Signal = {}) {
  const body = await spadeHttp(target, "GET", "/v1/search", options);
  return sure(parseSpadeSearchSettings(body), "web search settings");
}

/** The person's own SearXNG; null forgets it. Answers the settings as they now are. */
export async function setSearxngUrl(target: SpadeTarget, url: string | null) {
  const body = await spadeHttp(target, "PUT", "/v1/search", { body: { searxng_url: url } });
  return sure(parseSpadeSearchSettings(body), "web search settings");
}

/** The Brave Search key, kept in the OS keychain by Spade (ADR 0119). */
export async function setBraveKey(target: SpadeTarget, key: string): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/search/brave-key", { body: { key } });
}

export async function removeBraveKey(target: SpadeTarget): Promise<void> {
  await spadeHttp(target, "DELETE", "/v1/search/brave-key");
}
