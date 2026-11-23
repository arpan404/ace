/*
 * The voice names a speech model takes, for web's Settings. Which models can turn speech into
 * words or read words aloud is `voiceModelChoices` in `@ace/ui-core/spade-chat`, shared with the
 * iPhone.
 */

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
