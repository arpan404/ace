/*
 * What a shared-standard `SKILL.md` asks for, as every ace client says it (ADR 0202 §1). Pure.
 */

const andList = (words: readonly string[]) =>
  words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/**
 * A skill's `allowed-tools` in one sentence, or `undefined` when it lists none. It grants
 * nothing: Spade's gate decides each call (ADR 0202 decision 4).
 */
export function allowedToolsSentence(tools: readonly string[]): string | undefined {
  if (tools.length === 0) return undefined;
  return `It asks to run ${andList(tools)} without asking. Spade still decides each call.`;
}

/** Front matter fields this build keeps and doesn't use, or `undefined` when there are none. */
export function unusedFieldsSentence(fields: readonly string[]): string | undefined {
  if (fields.length === 0) return undefined;
  return `Not used by this Spade: ${andList(fields)}.`;
}
