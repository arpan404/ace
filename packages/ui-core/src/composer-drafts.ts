import { browserAnnotationLimit, type BrowserAnnotation } from "@ace/protocol";
import type { ComposerToken } from "./composer-tokens.ts";

/**
 * Browser annotations waiting in a draft (ADR 0082): each record with its element crop, and one
 * screenshot per annotated page, both uploads the daemon already holds.
 */
export interface DraftAnnotations {
  items: readonly {
    annotation: BrowserAnnotation;
    crop?: { sha256: string; name: string } | undefined;
  }[];
  pages: readonly { url: string; sha256: string; name: string }[];
}
/** An unsent message: its text, the files it mentions and the attachments already uploaded. */
export interface ComposerDraft {
  text: string;
  tokens?: readonly ComposerToken[] | undefined;
  /** Paths picked from the `@` list that are still written in the text. */
  mentions: readonly string[];
  /** Uploaded attachments; only ones the daemon already holds survive a reload. */
  attachments: readonly { sha256: string; name: string }[];
  annotations?: DraftAnnotations | undefined;
}

/** Drafts by key, least recently written first. */
export type DraftEntries = readonly (readonly [key: string, draft: ComposerDraft])[];

/** How many unsent drafts a device keeps, and how long one may be. */
export const draftLimits = { drafts: 50, chars: 100_000, attachments: 64 } as const;

/** A message can go with words, files, or both; whitespace alone carries nothing. */
export function messageHasContent(text: string, files: number): boolean {
  return text.trim().length > 0 || files > 0;
}

export function isEmptyDraft(draft: ComposerDraft | undefined): boolean {
  return (
    !draft ||
    (!messageHasContent(draft.text, draft.attachments.length) && !draft.annotations?.items.length)
  );
}

/** At most the message's limit of annotations, and only screenshots of pages they are on. */
export function boundedAnnotations(
  annotations: DraftAnnotations | undefined,
): DraftAnnotations | undefined {
  if (!annotations?.items.length) return undefined;
  const items = annotations.items.slice(0, browserAnnotationLimit);
  const urls = new Set(items.map((item) => item.annotation.url));
  const pages = annotations.pages.filter((page) => urls.has(page.url)).slice(0, urls.size);
  return { items, pages };
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
    tokens: draft.tokens?.filter((token) => token.end <= draftLimits.chars).slice(0, 64),
    mentions: draft.mentions.filter((path) => draft.text.includes(`@${path}`)),
    attachments: draft.attachments.slice(0, draftLimits.attachments),
  };
  const annotations = boundedAnnotations(draft.annotations);
  if (annotations) kept.annotations = annotations;
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
