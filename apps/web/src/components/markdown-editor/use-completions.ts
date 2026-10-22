import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { applyChange, selectionOf } from "./apply-change.ts";
import type {
  CompletionPerson,
  CompletionReference,
  MarkdownCompletions,
} from "./completion-source.ts";
import { completionAt, completionChange, type CompletionMatch } from "./completions.ts";

/** One suggestion: what it inserts and what it shows. */
export type CompletionItem =
  | { id: string; insert: string; kind: "person"; person: CompletionPerson }
  | { id: string; insert: string; kind: "reference"; reference: CompletionReference };

/** How long typing pauses before a search goes out. */
const searchDelayMs = 90;

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
  const [found, setFound] = useState<{ key: string; from: number; items: CompletionItem[] }>();
  const [active, setActive] = useState(0);
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

  const key = match && searchable(match) ? `${match.kind}:${match.query}` : undefined;
  useEffect(() => {
    if (!key || !match) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search =
        match.kind === "mention"
          ? source
              ?.people?.(match.query, controller.signal)
              .then((people) => items(match, people, []))
          : source
              ?.references?.(match.query, controller.signal)
              .then((references) => items(match, [], references));
      void search
        ?.then((next) => {
          if (controller.signal.aborted) return;
          setFound({ key, from: match.from, items: next });
          setActive(0);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFound({ key, from: match.from, items: [] });
        });
    }, searchDelayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `match` is read for its kind and query, both in `key`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source]);

  // While the next search is on its way, the word's earlier matches stay up rather than flicker.
  const list = key && found && (found.key === key || found.from === match?.from) ? found.items : [];
  const open = list.length > 0;
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
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move) {
      setActive((index) => (index + move + list.length) % list.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      const item = list[Math.min(active, list.length - 1)];
      if (item) choose(item);
    } else if (event.key === "Escape") {
      dismissed.current = match?.from;
      setMatch(undefined);
      // The list closes, not the dialog or panel around the editor.
      event.nativeEvent.stopPropagation();
    } else return false;
    event.preventDefault();
    return true;
  };
  return {
    match: open ? match : undefined,
    items: list,
    active: Math.min(active, Math.max(list.length - 1, 0)),
    setActive,
    choose,
    close,
    update,
    onKeyDown,
  };
}
