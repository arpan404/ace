import type { SpadeEndpoint, SpadeModelInfo } from "@ace/ui-core/spade-chat";

/*
 * Which of the person's own models can turn speech into words, or read words aloud (ADR 0134,
 * amended), for the one-click choice the mic and Settings offer. A model counts when its saved
 * facts say so, or when its endpoint lists it under a name such models go by (OpenAI's
 * `whisper-1` and `gpt-4o-mini-transcribe`, `tts-1` and `gpt-4o-mini-tts`; Groq's
 * `whisper-large-v3`; a local Kokoro). Only OpenAI-format endpoints serve those routes, and an
 * endpoint without its key can't be used yet.
 */

export type VoiceRole = "transcription" | "speech";

const named: Record<VoiceRole, RegExp> = {
  transcription: /whisper|transcri|speech-to-text|\bstt\b|parakeet|scribe/i,
  speech: /\btts\b|-tts|tts-|text-to-speech|kokoro|orpheus/i,
};

export interface VoiceModelChoice {
  /** `endpoint/model`, as the setting takes it. */
  model: string;
  endpointName: string;
  modelName: string;
}

const serves = (model: SpadeModelInfo, role: VoiceRole) =>
  model.capabilities.includes(role) ||
  (named[role].test(model.id) && !(role === "speech" && named.transcription.test(model.id)));

/** Endpoints that could serve a voice route now: OpenAI-format, with their key when they need one. */
export function voiceEndpoints(endpoints: readonly SpadeEndpoint[]): SpadeEndpoint[] {
  return endpoints.filter(
    (endpoint) =>
      endpoint.format !== "anthropic" && (!endpoint.needsKey || endpoint.keySet === true),
  );
}

/**
 * One choice per endpoint, in the person's order: the model its facts mark first, else the
 * first listed whose name says so. `live` holds each endpoint's own list, where it was read.
 */
export function voiceModelChoices(
  role: VoiceRole,
  endpoints: readonly SpadeEndpoint[],
  live: ReadonlyMap<string, readonly SpadeModelInfo[]>,
): VoiceModelChoice[] {
  const choices: VoiceModelChoice[] = [];
  for (const endpoint of voiceEndpoints(endpoints)) {
    const models = [...endpoint.models, ...(live.get(endpoint.id) ?? [])];
    const chosen =
      models.find((model) => model.capabilities.includes(role)) ??
      models.find((model) => serves(model, role));
    if (chosen)
      choices.push({
        model: `${endpoint.id}/${chosen.id}`,
        endpointName: endpoint.name,
        modelName: chosen.name || chosen.id,
      });
  }
  return choices;
}

/** The voices OpenAI-format speech models take; others ignore a name they don't know. */
export const endpointVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;
