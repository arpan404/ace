import { useCallback, useRef, useState, type RefObject } from "react";
import { applyChange, selectionOf } from "./apply-change.ts";
import type {
  CompletionPerson,
  CompletionReference,
  MarkdownCompletions,
} from "./completion-source.ts";
import {
  completionAt,
  completionChange,
  referenceMatches,
  type CompletionMatch,
} from "@ace/ui-core";
import { useSearch } from "./use-search.ts";

/** One suggestion: what it inserts and what it shows. */
export type CompletionItem =
  | { id: string; insert: string; kind: "person"; person: CompletionPerson }
  | { id: string; insert: string; kind: "reference"; reference: CompletionReference };

function items(
  match: CompletionMatch,
  people: readonly CompletionPerson[],
  references: readonly CompletionReference[],
): CompletionItem[] {
  return match.kind === "mention"
    ? people.slice(0, 8).map((person) => ({
        id: `person-${person.login}`,
        insert: `@${person.login}`,
        kind: "person",
        person,
      }))
    : references.slice(0, 8).map((reference) => ({
        id: `reference-${reference.number}`,
        insert: `#${reference.number}`,
        kind: "reference",
        reference,
      }));
}

/**
 * `@` and `#` suggestions for a textarea: the word at the caret, its matches from `source`
 * (searched once typing pauses; a newer word cancels an older search), which one is
 * highlighted, and the keys that move through them, take one, or close the list.
 */
export function useCompletions(
  field: RefObject<HTMLTextAreaElement | null>,
  source: MarkdownCompletions | undefined,
) {
  const [match, setMatch] = useState<CompletionMatch>();
  // The highlighted row, for the answer it was moved in; a new answer starts at its first row.
  const [highlight, setHighlight] = useState({ answer: "", index: 0, moved: false });
  // Escape closes the list for that word until the caret leaves it.
  const dismissed = useRef<number | undefined>(undefined);
  const searchable = (m: CompletionMatch | undefined) =>
    m && (m.kind === "mention" ? source?.people : source?.references) ? m : undefined;

  const update = useCallback(() => {
    const target = field.current;
    const next = target ? completionAt(selectionOf(target)) : undefined;
    if (dismissed.current !== undefined && next?.from !== dismissed.current)
      dismissed.current = undefined;
    setMatch((current) => {
      const shown = next && dismissed.current === undefined ? next : undefined;
      if (
        current &&
        shown &&
        current.from === shown.from &&
        current.to === shown.to &&
        current.query === shown.query
      )
        return current;
      return shown;
    });
  }, [field]);

  // The word's kind and place are in the key: a new word, or `#` typed where `@` was, never
  // shows the old word's answer.
  const word = match && searchable(match) ? `${match.kind}:${match.from}:` : undefined;
  const key = word && match ? `${word}${match.query}` : undefined;
  const found = useSearch(key, async (signal) => {
    if (!match) return [];
    return match.kind === "mention"
      ? items(match, (await source?.people?.(match.query, signal)) ?? [], [])
      : items(match, [], (await source?.references?.(match.query, signal)) ?? []);
  });
  // While the next search is on its way, the same word's earlier matches stay up rather than
  // flicker, narrowed to what is typed now: every word typed must start a word of the title, so
  // ordinary prose after a `#` closes the list.
  const kept = word && found?.key.startsWith(word) ? (found.value ?? []) : [];
  const phrase = match?.kind === "reference" && match.query.includes(" ");
  const list =
    match?.kind === "reference"
      ? kept.filter(
          (item) => item.kind !== "reference" || referenceMatches(item.reference, match.query),
        )
      : kept;
  const open = list.length > 0;
  const answer = found?.key ?? "";
  const current = highlight.answer === answer;
  /**
   * A row is highlighted only where Enter or Tab would take it: in the answer to what is typed
   * now (an older answer's rows may not match it), and after a title phrase only once the
   * person has moved the highlight, since Enter there is as likely the end of a sentence.
   * Otherwise nothing is highlighted, and the field names no row to assistive technology.
   */
  const highlighted = found?.key === key && (!phrase || (current && highlight.moved));
  const active = highlighted
    ? Math.min(current ? highlight.index : 0, Math.max(list.length - 1, 0))
    : -1;
  const setActive = useCallback(
    (index: number) => setHighlight({ answer, index, moved: true }),
    [answer],
  );
  const close = useCallback(() => {
    setMatch(undefined);
  }, []);
  const choose = useCallback(
    (item: CompletionItem) => {
      const target = field.current;
      if (!target || !match) return;
      applyChange(target, completionChange(selectionOf(target), match, item.insert));
      setMatch(undefined);
    },
    [field, match],
  );
  /** Handles the key when the list is open; true when it did. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // Safari confirms an IME composition with an Enter whose isComposing is false: keyCode 229.
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move) {
      // From no highlight, Down starts at the first row and Up at the last.
      const from = active < 0 ? (move > 0 ? -1 : list.length) : active;
      // An older answer's rows are never taken: wait for this one's.
      if (found?.key === key) setActive((from + move + list.length) % list.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      // Nothing highlighted: the key does what it would without the list.
      const item = active < 0 ? undefined : list[active];
      if (!item) return false;
      choose(item);
    } else if (event.key === "Escape") {
      dismissed.current = match?.from;
      setMatch(undefined);
    } else return false;
    // The key belongs to the list: a dialog or panel around the editor never sees it (Escape
    // would close it too), whether it listens through React or on the document.
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    return true;
  };
  return {
    match: open ? match : undefined,
    items: list,
    active,
    setActive,
    choose,
    close,
    update,
    onKeyDown,
  };
}
