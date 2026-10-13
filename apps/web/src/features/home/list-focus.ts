import { homeRowThread, type HomeRow } from "@ace/ui-core";

export const rowFocusSelector = "[data-row-focus], [data-section-toggle]";

/**
 * A row's actions (Snooze, Settle, ⋯) sit outside the Tab order, so the list stays one stop:
 * → from the row moves into them and on along them, ← moves back and finally to the row.
 * Returns whether it moved focus.
 */
export function stepIntoActions(event: {
  key: string;
  target: EventTarget;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
}): boolean {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return false;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  if (!(event.target instanceof HTMLElement)) return false;
  const rowBox = event.target.closest<HTMLElement>("[data-index]");
  const link = rowBox?.querySelector<HTMLElement>("[data-row-focus]");
  if (!rowBox || !link) return false;
  const stops = [
    link,
    ...rowBox.querySelectorAll<HTMLElement>("button:not([data-drag-handle]):not([disabled])"),
  ];
  const at = stops.indexOf(event.target);
  if (at < 0) return false;
  const next = stops[at + (event.key === "ArrowRight" ? 1 : -1)];
  if (!next) return false;
  event.preventDefault();
  next.focus();
  return true;
}

/**
 * The list is one Tab stop (a roving tabindex): the row that last had focus, else the open
 * thread's, else the first. ↑ and ↓ move between rows; every other row is out of the Tab order.
 */
export function roveListFocus(list: HTMLElement, remembered: Element | null): void {
  const targets = [...list.querySelectorAll<HTMLElement>(rowFocusSelector)];
  const active = list.ownerDocument.activeElement;
  const stop =
    targets.find((target) => target === active) ??
    targets.find((target) => target === remembered) ??
    targets.find((target) => target.getAttribute("aria-current") === "page") ??
    targets[0];
  for (const target of targets) target.tabIndex = target === stop ? 0 : -1;
}

/** Walk the focus sequence, including each Unsent link, across the virtual window. */
export async function focusListRow(options: {
  viewport: HTMLElement | null;
  rows: readonly { item: HomeRow; phase: string }[];
  from: HTMLElement;
  index: number;
  step: number;
  mount(index: number): void;
}): Promise<string | undefined> {
  const { viewport, rows, from, step } = options;
  if (!viewport) return undefined;
  const targets = (index: number) => [
    ...(viewport
      .querySelector(`[data-index="${index}"]`)
      ?.querySelectorAll<HTMLElement>(rowFocusSelector) ?? []),
  ];
  const siblings = targets(options.index);
  const sibling = siblings[siblings.indexOf(from) + step];
  if (sibling) {
    sibling.focus();
    return homeRowThread(rows[options.index]?.item ?? { kind: "unsent" });
  }
  for (let index = options.index + step; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];
    if (
      !row ||
      row.phase === "exit" ||
      row.item.kind === "pinned-header" ||
      row.item.kind === "pinned-end"
    )
      continue;
    options.mount(index);
    // Scrolling an offscreen virtual row mounts it on the next browser frame.
    if (!viewport.querySelector(`[data-index="${index}"]`))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const links = targets(index);
    const next = step > 0 ? links[0] : links.at(-1);
    if (!next) continue;
    next.focus();
    return homeRowThread(row.item);
  }
  return undefined;
}
