import type { CatalogMention } from "@ace/protocol";
import {
  pickSuggestion,
  suggestionToken,
  type ComposerSuggestion,
  type HeldReferences,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * One suggestion as Swift draws and picks it: what it reads, its symbol, what picking it does
 * (`pickSuggestion`, shared with the web) and, for a reference, the words to insert and what
 * they point at, which Swift keeps beside the message and hands back on send
 * (`composer-references.ts`). Pure.
 */

export type { HeldReferences };
/** A suggestion with a stable id within its list. */
export type RowSource = ComposerSuggestion & { id: string };

/** The reference a row leaves in the message, with a prompt's arguments when it has them. */
export function rowReference(
  source: RowSource,
  values?: NonNullable<CatalogMention["values"]>,
): Record<string, unknown> {
  const { start: _start, end: _end, ...reference } = suggestionToken(source, 0, values);
  return reference;
}

/** A prompt's parameters as its form asks for them, each with its default as typed text. */
function parameters(source: RowSource) {
  const invocation = source.entry?.invocation;
  if (invocation?.type !== "prompt") return [];
  return Object.entries(invocation.parameters ?? {}).map(([name, parameter]) => ({
    name,
    type: parameter.type,
    required: parameter.required,
    value: parameter.default === undefined ? "" : String(parameter.default),
  }));
}

export function suggestionRow(
  source: RowSource,
  held: HeldReferences,
  preview: Preview,
): Record<string, unknown> {
  const pick = pickSuggestion(source, held);
  return {
    id: source.id,
    group: source.group,
    label: preview(source.label, 256),
    detail: source.detail ? preview(source.detail, 512) : null,
    icon: source.path
      ? "file"
      : source.threadId
        ? "thread"
        : source.tab
          ? "tab"
          : (source.entry?.kind ?? "command"),
    pick: pick.kind,
    notice: pick.kind === "refused" ? pick.notice : null,
    action: pick.kind === "action" ? pick.action : null,
    parameters: pick.kind === "arguments" ? parameters(source) : [],
    reference: pick.kind === "reference" ? rowReference(source) : null,
  };
}
