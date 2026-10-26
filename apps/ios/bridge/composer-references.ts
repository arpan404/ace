import {
  BrowserTabContextItem,
  CatalogMention,
  Mention,
  ThreadRefContextItem,
  type CatalogEntry,
  type CommandPayload,
  type ContentPart,
  type MessageContext,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import {
  composerInput,
  parseGoalCommand,
  referenceContext,
  referenceLimits,
  withTypedCommand,
  type ComposerToken,
} from "@ace/ui-core";
import { z } from "zod";

/*
 * The references a phone message carries. The phone's text view holds plain words; each row
 * picked from `@` or `/` is remembered beside them as the words it inserted and what they point
 * at. On send the bridge finds each one still written in the message (deleted or edited words
 * drop it) and builds what the web's composer sends: catalog entries inline in `input`, files
 * as `context.mentions`, threads and browser tabs as `context.items`. Pure.
 */

export const Reference = z.object({
  label: z.string().min(1).max(1024),
  catalog: CatalogMention.optional().catch(undefined),
  file: Mention.optional().catch(undefined),
  thread: ThreadRefContextItem.optional().catch(undefined),
  browserTab: BrowserTabContextItem.optional().catch(undefined),
});
export type Reference = z.infer<typeof Reference>;
/** What a send carries beside its words; a malformed entry is dropped, never fatal. */
export const References = z
  .array(z.unknown())
  .max(referenceLimits.all)
  .transform((raw) => raw.flatMap((value) => Reference.safeParse(value).data ?? []));

/** A reference's words start a word and end one, so `@main.ts` never claims `@main.tsx`. */
function at(text: string, label: string, from: number): number {
  for (let index = text.indexOf(label, from); index >= 0; index = text.indexOf(label, index + 1)) {
    const before = text[index - 1];
    const after = text[index + label.length];
    if ((before === undefined || /\s/.test(before)) && (after === undefined || !/\w/.test(after)))
      return index;
  }
  return -1;
}

/**
 * Each reference at the first place its words are still written and not claimed by another,
 * in the message's order. One whose words are gone is left out.
 */
export function placeReferences(text: string, references: readonly Reference[]): ComposerToken[] {
  const placed: ComposerToken[] = [];
  const overlaps = (start: number, end: number) =>
    placed.some((token) => start < token.end && token.start < end);
  for (const reference of references) {
    let start = at(text, reference.label, 0);
    while (start >= 0 && overlaps(start, start + reference.label.length))
      start = at(text, reference.label, start + 1);
    if (start < 0) continue;
    const { label, catalog, file, thread, browserTab } = reference;
    if (!catalog && !file && !thread && !browserTab) continue;
    placed.push({
      start,
      end: start + label.length,
      label,
      ...(catalog ? { catalog } : {}),
      ...(file ? { file } : {}),
      ...(thread ? { thread } : {}),
      ...(browserTab ? { browserTab } : {}),
    });
  }
  return placed.toSorted((a, b) => a.start - b.start);
}

export interface MessageContent {
  input: ContentPart[];
  /** Files, threads and tabs the message points at; undefined when it points at none. */
  references: Pick<MessageContext, "mentions" | "items"> | undefined;
}

/**
 * The message as the web sends it: references placed in the words, and a `/name` typed without
 * picking it still invoking the catalog entry of that name.
 */
export function messageContent(
  text: string,
  references: readonly Reference[],
  entries: readonly CatalogEntry[] | undefined,
): MessageContent {
  const tokens = withTypedCommand(text, placeReferences(text, references), entries);
  const context = referenceContext(tokens);
  return {
    input: composerInput(text, tokens),
    references:
      context.items.length || context.mentions.length
        ? {
            mentions: context.mentions,
            ...(context.items.length ? { items: context.items } : {}),
          }
        : undefined,
  };
}

/** The files' context (draft scope, attachments) joined with the references'. */
export function joinContext(
  files: MessageContext | undefined,
  references: MessageContent["references"],
): MessageContext | undefined {
  if (!references) return files;
  return {
    ...files,
    mentions: references.mentions,
    attachments: files?.attachments ?? [],
    ...(references.items ? { items: references.items } : {}),
  };
}

/**
 * `/goal <objective>` (or `/goal clear`, `pause`, `resume`) sets the provider's own goal where the
 * thread supports goals, as the web's composer does; with files or references it is a message.
 */
export function goalCommand(
  threadId: ThreadId,
  thread: Pick<Thread, "capabilities"> | undefined,
  text: string,
  carriesMore: boolean,
): CommandPayload | undefined {
  if (!thread?.capabilities?.goals || carriesMore) return undefined;
  const change = parseGoalCommand(text);
  if (!change) return undefined;
  return change === "clear"
    ? { type: "thread.goal.clear", threadId }
    : { type: "thread.goal.set", threadId, change };
}
