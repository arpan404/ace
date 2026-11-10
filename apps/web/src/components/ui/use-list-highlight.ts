import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { applePlatform } from "@/lib/keymap.ts";
import { listKey, type ListKeyAction } from "./list-keys.ts";

/** Where the highlight is and what put it there. */
interface Highlight {
  at: number;
  by: "keys" | "pointer";
}

/**
 * The highlight of a combobox's list: the row the field points at (`aria-activedescendant`),
 * moved by the keys in `list-keys.ts` or by the pointer. A row the keys reach is scrolled into
 * view, once per move (`reveal` brings in a virtual row that isn't mounted yet); a row the pointer
 * highlights stops being highlighted when the pointer leaves the list. What a pick does is the
 * caller's: `key` returns the pick, or `pass` for keys the field handles itself.
 */
export function useListHighlight(options: {
  count: number;
  /** The row highlighted before any move, if any. */
  start?: number;
  reveal?(at: number): void;
}) {
  const { count } = options;
  const listId = useId();
  const [highlight, setHighlight] = useState<Highlight | undefined>(
    options.start === undefined ? undefined : { at: options.start, by: "keys" },
  );
  const current = highlight && highlight.at < count ? highlight.at : undefined;
  const optionId = (at: number) => `${listId}-${at}`;
  const reveal = useRef(options.reveal);
  reveal.current = options.reveal;

  useEffect(() => {
    if (highlight?.by !== "keys" || current === undefined) return;
    const element = document.getElementById(`${listId}-${current}`);
    if (element) element.scrollIntoView?.({ block: "nearest" });
    else reveal.current?.(current);
  }, [highlight, current, listId]);

  return {
    listId,
    optionId,
    current,
    /** The highlight came from the pointer. */
    pointed: highlight?.by === "pointer" && current !== undefined,
    /** Highlights `at` by the keys, or clears it. */
    reset: (at?: number) => setHighlight(at === undefined ? undefined : { at, by: "keys" }),
    point: (at: number) => setHighlight({ at, by: "pointer" }),
    /** The pointer left the list: a row it highlighted lets go. */
    leave: () => setHighlight((last) => (last?.by === "pointer" ? undefined : last)),
    /**
     * Applies `event` to the list: a move is taken (its default prevented); a pick is returned
     * for the caller to act on; any other key passes.
     */
    key: (
      event: KeyboardEvent<HTMLInputElement>,
      pickable: (at: number) => boolean,
    ): Exclude<ListKeyAction, { kind: "move" }> | { kind: "moved" } => {
      const action = listKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing,
        },
        { current, count, pickable },
        applePlatform,
      );
      if (action.kind !== "move") return action;
      event.preventDefault();
      setHighlight(action.to === undefined ? undefined : { at: action.to, by: "keys" });
      return { kind: "moved" };
    },
  };
}

export type ListHighlight = ReturnType<typeof useListHighlight>;
