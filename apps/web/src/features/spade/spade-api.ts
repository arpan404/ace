import {
  parseSpadeAgent,
  parseSpadeAgents,
  parseSpadeEndpoint,
  parseSpadeLiveModels,
  parseSpadeModels,
  parseSpadeSearchSettings,
  parseSpadeSubscriptions,
  parseSpadeTaskHistory,
  parseSpadeTranscription,
  type SpadeAgent,
  type SpadeEndpoint,
  type SpadeFormat,
  type SpadeModelInfo,
  type SpadeModels,
  type SpadeSubscription,
  type SpadeTaskVersion,
} from "@ace/ui-core/spade-chat";
import { segment, spadeBody, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

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
export type SpadeNewAgent = Omit<SpadeAgentDraft, "model" | "name"> & {
  /** Absent with `naming`: the bot names itself in its first reply. */
  name?: string;
  model?: string;
  template?: string;
  time_zone?: string;
  /** Made from one message: the bot chooses its name and face as it starts. */
  naming?: boolean;
};

/**
 * Makes a bot. With `first`, its first message goes in the same call (the new-bot conversation):
 * Spade makes the bot and sends the message together, or does neither and says why. An older
 * Spade that answers without the message gets it sent on its own.
 */
export async function createAgent(
  target: SpadeTarget,
  draft: SpadeNewAgent,
  first?: { text: string; images: readonly { data: string }[] },
) {
  const sent = first
    ? {
        ...draft,
        first_message: {
          text: first.text,
          ...(first.images.length ? { images: first.images.map(({ data }) => ({ data })) } : {}),
        },
      }
    : draft;
  const body = await spadeHttp(target, "POST", "/v1/agents", { body: sent });
  const agent = sure(parseSpadeAgent(body), "new agent");
  // A Spade from before first messages makes the bot and drops the message: send it now.
  if (first && !agent.lastMessage)
    await spadeHttp(target, "POST", `/v1/conversations/${segment(agent.conversation)}/messages`, {
      body: spadeBody(first),
    });
  return agent;
}

/** Name and avatar change at once; task and model apply from the agent's next turn. */
export async function editAgent(
  target: SpadeTarget,
  id: string,
  change: Partial<SpadeAgentDraft> & {
    /** The person's one line on a task change (Undo, a restore), kept in its history. */
    task_why?: string;
  },
): Promise<SpadeAgent> {
  const body = await spadeHttp(target, "PATCH", `/v1/agents/${segment(id)}`, { body: change });
  return sure(parseSpadeAgent(body), "agent");
}

/** Each version of the bot's task, newest first, with who changed it and why. */
export async function readTaskHistory(
  target: SpadeTarget,
  id: string,
  options: Signal = {},
): Promise<SpadeTaskVersion[]> {
  const body = await spadeHttp(target, "GET", `/v1/agents/${segment(id)}/task/history`, options);
  return sure(parseSpadeTaskHistory(body), "task history");
}

/** Deletes the agent and its conversation. */
export async function deleteAgent(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/agents/${segment(id)}`);
}

/**
 * Marks a bot's or group's conversation seen up to `seq` (its last event when absent); Spade
 * never moves the cursor back. Answers the cursor where it now is.
 */
export async function markSeen(
  target: SpadeTarget,
  conversation: string,
  seq: number | undefined,
): Promise<void> {
  await spadeHttp(target, "PUT", `/v1/conversations/${segment(conversation)}/seen`, {
    body: seq === undefined ? {} : { seq },
  });
}

/** Pins a bot to the strip under the list's buttons, or unpins it; kept in Spade, on every device. */
export async function pinAgent(target: SpadeTarget, id: string, pinned: boolean): Promise<void> {
  await spadeHttp(target, "PUT", `/v1/agents/${segment(id)}/pin`, { body: { pinned } });
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

/** `endpoint/model` a new bot starts on; null: the person's first usable model. */
export async function setNewBotModel(target: SpadeTarget, model: string | null): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/settings", { body: { new_bot_model: model } });
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
