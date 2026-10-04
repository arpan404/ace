/** An unsent message: its text, the files it mentions and the attachments already uploaded. */
export interface ComposerDraft {
  text: string;
  /** Paths picked from the `@` list that are still written in the text. */
  mentions: readonly string[];
  /** Uploaded attachments; only ones the daemon already holds survive a reload. */
  attachments: readonly { sha256: string; name: string }[];
}

/** Drafts by key, least recently written first. */
export type DraftEntries = readonly (readonly [key: string, draft: ComposerDraft])[];

/** How many unsent drafts a device keeps, and how long one may be. */
export const draftLimits = { drafts: 50, chars: 100_000, attachments: 32 } as const;

export function isEmptyDraft(draft: ComposerDraft | undefined): boolean {
  return !draft || (!draft.text.trim() && !draft.attachments.length);
}

export function findDraft(entries: DraftEntries, key: string): ComposerDraft | undefined {
  return entries.find(([candidate]) => candidate === key)?.[1];
}

/**
 * Store `draft` under `key` as the most recent one. An empty draft removes the key, and the
 * oldest drafts fall off past the limit, so the stored list never grows without bound.
 */
export function putDraft(
  entries: DraftEntries,
  key: string,
  draft: ComposerDraft | undefined,
  limit: number = draftLimits.drafts,
): DraftEntries {
  const rest = entries.filter(([candidate]) => candidate !== key);
  if (!draft || isEmptyDraft(draft)) return rest;
  const kept: ComposerDraft = {
    text: draft.text.slice(0, draftLimits.chars),
    mentions: draft.mentions.filter((path) => draft.text.includes(`@${path}`)),
    attachments: draft.attachments.slice(0, draftLimits.attachments),
  };
  return [...rest, [key, kept] as const].slice(-limit);
}

/** Most recent first, without repeats, at most `limit` long. */
export function touchRecent(
  list: readonly string[],
  value: string,
  limit: number,
): readonly string[] {
  return [value, ...list.filter((entry) => entry !== value)].slice(0, limit);
}
