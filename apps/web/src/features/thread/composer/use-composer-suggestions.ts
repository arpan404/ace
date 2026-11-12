import { useState } from "react";
import type { ThreadRef } from "../sources/index.ts";
import { triggerAt, type Trigger } from "./draft.ts";
import { useSuggestions, type Suggestion, type Suggestions } from "./suggestions.tsx";

/** The names matching what follows `@`: those starting with it first, then any containing it. */
function nameSuggestions(names: readonly string[], query: string): Suggestions {
  const typed = query.toLowerCase();
  const items = names
    .filter((name) => name.toLowerCase().includes(typed))
    .toSorted(
      (a, b) =>
        Number(b.toLowerCase().startsWith(typed)) - Number(a.toLowerCase().startsWith(typed)),
    )
    .map((name): Suggestion => ({
      insert: `@${name}`,
      label: name,
      kind: "mention",
      group: "Members",
      plain: true,
    }));
  return items.length ? { state: "ready", kind: "mention", items } : { state: "closed" };
}

/**
 * The suggestion list for the token at the caret (`@file`, a leading `/command`, or the + menu
 * while `adding`), its highlighted row, and the token Esc dismissed so it stays closed until
 * the person types again.
 */
export function useComposerSuggestions(
  thread: ThreadRef,
  text: string,
  caret: number,
  recent: () => readonly string[],
  /** No project or commands to suggest (Spade): `@`, `/` and + open no list. */
  off = false,
  /** While `off`: names `@` offers instead, inserted as plain text. */
  names?: readonly string[],
) {
  "use no memo";
  const [dismissed, setDismissed] = useState<number>();
  const [highlight, setHighlight] = useState({ key: "", index: 0 });
  const [adding, setAdding] = useState(false);
  const found = adding
    ? { kind: "command" as const, query: "", start: caret, end: caret }
    : triggerAt(text, caret);
  const open = found && found.start !== dismissed ? found : undefined;
  const named = off && names?.length && open?.kind === "mention" ? open : undefined;
  const trigger: Trigger | undefined = off ? named : open;
  const listed = useSuggestions(thread, named ? undefined : trigger, recent, adding);
  const suggestions = named ? nameSuggestions(names ?? [], named.query) : listed;
  const items = suggestions.state === "ready" ? suggestions.items : [];
  // The highlight resets whenever the token being completed changes.
  const listKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : "";
  const active = Math.min(
    highlight.key === listKey ? highlight.index : 0,
    Math.max(0, items.length - 1),
  );
  return {
    trigger,
    suggestions,
    items,
    active,
    adding,
    setAdding,
    /** Keep the token starting here closed; undefined lets any token open the list again. */
    setDismissed,
    /** Keep the token at the end of `next` closed, for text the person didn't type there. */
    dismissAt: (next: string, at: number) => setDismissed(triggerAt(next, at)?.start),
    highlight: (index: number) => setHighlight({ key: listKey, index }),
    /** Close the list for the token being completed (Esc, a click away). */
    close: () => {
      setAdding(false);
      setDismissed(trigger?.start);
    },
  };
}
