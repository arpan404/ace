import { useNavigate } from "@tanstack/react-router";
import { useRef, type KeyboardEvent } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { rowFocusSelector } from "./list-focus.ts";
import { useListQuery, useListQueryStore } from "./list-query.ts";
import type { HomeList } from "./use-home-threads.ts";

/** The first thread the list shows for the words typed: pinned, then in Home order. */
export function firstMatch(list: HomeList): string | undefined {
  return [...list.pinned, ...list.active, ...list.recent, ...list.snoozed, ...list.settled][0];
}

/**
 * Search at the top of the thread list: typing narrows the list to threads whose title,
 * project or branch has the words. ↓ moves into the rows, Enter opens the first, Esc clears the
 * words and goes back to where focus was. ⌥⌘F comes here from anywhere.
 */
export function ListSearch(props: { list: HomeList }) {
  const query = useListQuery();
  const store = useListQueryStore();
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const field = () => box.current?.querySelector("input") ?? null;
  /** Where focus was before the field took it, for Esc to return to. */
  const cameFrom = useRef<HTMLElement | null>(null);
  useHotkey(keymap.focusListSearch.keys, () => {
    const input = field();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== input) cameFrom.current = active;
    input?.focus();
    input?.select();
  });
  const leave = () => {
    const back = cameFrom.current;
    cameFrom.current = null;
    if (back?.isConnected && back !== document.body) back.focus();
    else field()?.blur();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown") {
      const first = box.current
        ?.closest("nav")
        ?.querySelector<HTMLElement>(
          `[role="list"][aria-label="Threads"] :is(${rowFocusSelector})`,
        );
      if (!first) return;
      event.preventDefault();
      first.focus();
    } else if (event.key === "Enter") {
      const id = firstMatch(props.list);
      if (!query.trim() || !id) return;
      event.preventDefault();
      void navigate({ to: "/t/$threadId", params: { threadId: id } });
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query) store.set("");
      leave();
    }
  };
  return (
    <div ref={box} className="shrink-0 px-2 pb-1">
      <SearchField
        label="Search threads"
        placeholder="Search"
        value={query}
        onValueChange={store.set}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const from = event.relatedTarget;
          if (from instanceof HTMLElement && from !== event.currentTarget) cameFrom.current = from;
        }}
        className="h-7"
      />
    </div>
  );
}
