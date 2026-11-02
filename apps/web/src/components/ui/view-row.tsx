import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type RefCallback,
} from "react";

/** The rows of a view list: links and buttons around a `PanelRowBody`, or marked `data-view-row`. */
function rowsOf(list: HTMLElement): HTMLElement[] {
  const rows = new Set<HTMLElement>();
  for (const element of list.querySelectorAll<HTMLElement>(
    "[data-view-row-title], [data-view-row]",
  )) {
    const row = element.hasAttribute("data-view-row")
      ? element
      : element.closest<HTMLElement>("a[href], button");
    if (row && list.contains(row)) rows.add(row);
  }
  return [...rows].filter((row) => !row.hasAttribute("disabled") && !row.closest("[hidden]"));
}

const titleOf = (row: HTMLElement) =>
  (row.querySelector("[data-view-row-title]")?.textContent ?? row.textContent ?? "")
    .trim()
    .toLowerCase();

/** The row that takes Tab: the focused one, else the selected one, else the first. */
function homeRow(rows: HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement;
  return (
    rows.find((row) => row === active) ??
    rows.find(
      (row) => row.getAttribute("aria-current") === "page" || row.dataset.status === "active",
    ) ??
    rows[0]
  );
}

/**
 * The rows of a list that mounts only some of them (`VirtualList`), so keys can reach the rest:
 * how many there are, each one's title (undefined for a label that never takes focus), and how
 * to bring one into view so it mounts.
 */
export interface ViewListRows {
  count: number;
  titleAt(index: number): string | undefined;
  reveal(index: number): void;
}

/** The row `key` moves to from `current` among `rows`' focusable ones, if it is a moving key. */
function nextIndex(rows: ViewListRows, current: number, key: string): number | undefined {
  const focusable = (index: number) => rows.titleAt(index) !== undefined;
  const walk = (from: number, step: number) => {
    for (let index = from; index >= 0 && index < rows.count; index += step)
      if (focusable(index)) return index;
    return undefined;
  };
  if (key === "ArrowDown") return walk(current + 1, 1) ?? current;
  if (key === "ArrowUp") return walk(current - 1, -1) ?? current;
  if (key === "Home") return walk(0, 1);
  if (key === "End") return walk(rows.count - 1, -1);
  return undefined;
}

/** The next row after `current`, wrapping round, whose title starts with `letter`. */
function typedIndex(rows: ViewListRows, current: number, letter: string): number | undefined {
  for (let step = 1; step <= rows.count; step++) {
    const index = (current + step) % rows.count;
    if (rows.titleAt(index)?.trim().toLowerCase().startsWith(letter)) return index;
  }
  return undefined;
}

/** Focus row `index` of a virtual list, bringing it into view and waiting for it to mount. */
async function focusIndex(list: HTMLElement, rows: ViewListRows, index: number): Promise<void> {
  for (let frame = 0; frame < 10; frame++) {
    const box = list.querySelector<HTMLElement>(`[data-index="${index}"]`);
    const row = box ? rowsOf(box)[0] : undefined;
    if (row) {
      row.focus();
      row.scrollIntoView?.({ block: "nearest" });
      return;
    }
    // Scrolling an unmounted row in mounts it on the next frame; rows measured on the way can
    // move it, so scroll to it again until it is there.
    rows.reveal(index);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/**
 * Keyboard for a view's list in the sidebar (Skills, More, Automations) or on a page (Pull
 * requests, History): the list is one Tab stop, ↑/↓ move between rows, Home/End jump to the
 * ends, and typing a letter moves to the next row whose title starts with it. Enter is the row's
 * own (it is a link or button). Spread the result on the element that holds the rows. A list that
 * mounts only some rows passes them (`virtual`), so the keys reach rows not yet mounted.
 */
export function useViewListKeys<T extends HTMLElement>(
  virtual?: ViewListRows,
): {
  ref: RefCallback<T>;
  onKeyDown: KeyboardEventHandler<T>;
} {
  const [list, setList] = useState<T | null>(null);
  const listRef = useRef<T | null>(null);
  const virtualRef = useRef(virtual);
  useEffect(() => {
    virtualRef.current = virtual;
  });
  const ref = useCallback<RefCallback<T>>((element) => {
    listRef.current = element;
    setList(element);
  }, []);

  // Roving tabindex, kept right as rows come, go and change selection.
  useEffect(() => {
    if (!list) return;
    const rove = () => {
      const rows = rowsOf(list);
      const home = homeRow(rows);
      for (const row of rows) {
        const index = row === home ? "0" : "-1";
        if (row.getAttribute("tabindex") !== index) row.setAttribute("tabindex", index);
      }
    };
    rove();
    const observer = new MutationObserver(rove);
    observer.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current", "data-status", "disabled", "hidden"],
    });
    list.addEventListener("focusin", rove);
    return () => {
      observer.disconnect();
      list.removeEventListener("focusin", rove);
    };
  }, [list]);

  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    const element = listRef.current;
    if (!element || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const rows = rowsOf(element);
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    const model = virtualRef.current;
    const at = rows[current]?.closest<HTMLElement>("[data-index]");
    if (model && at && element.contains(at)) {
      const index = Number(at.dataset.index);
      const typed = event.key.length === 1 && /\S/.test(event.key);
      const target = typed
        ? typedIndex(model, index, event.key.toLowerCase())
        : nextIndex(model, index, event.key);
      // A letter is not prevented: it may also start a sequence shortcut ("g h").
      if (!typed && target !== undefined) event.preventDefault();
      if (target !== undefined) void focusIndex(element, model, target);
      return;
    }
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(current + 1, rows.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Not prevented: a letter may also start a sequence shortcut ("g h").
      const letter = event.key.toLowerCase();
      const order = [...rows.slice(current + 1), ...rows.slice(0, current + 1)];
      const match = order.find((row) => titleOf(row).startsWith(letter));
      match?.focus();
      match?.scrollIntoView?.({ block: "nearest" });
      return;
    } else return;
    event.preventDefault();
    const target = rows[next];
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return { ref, onKeyDown };
}

/**
 * A view's list in the sidebar that failed while the main pane explains why: one quiet line and a way
 * to read it again, so the failure isn't told twice in two voices.
 */
export function ViewSidebarError(props: { onRetry(): void }) {
  return (
    <p className="flex items-center gap-1.5 px-[11px] pt-3 text-sm text-muted-foreground">
      Couldn't load the list.
      <button
        type="button"
        onClick={props.onRetry}
        className="rounded-sm font-medium text-foreground underline-offset-2 focus-ring hover:underline"
      >
        Try again
      </button>
    </p>
  );
}
