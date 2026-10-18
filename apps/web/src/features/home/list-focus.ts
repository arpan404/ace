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
  return focusRowFrom({ viewport, rows, start: options.index + step, step, mount: options.mount });
}

/** Whether a row can hold focus: not leaving, and not the Pinned group's heading or rule. */
function focusable(row: { item: HomeRow; phase: string } | undefined): boolean {
  return (
    row !== undefined &&
    row.phase !== "exit" &&
    row.item.kind !== "pinned-header" &&
    row.item.kind !== "pinned-end"
  );
}

/**
 * Focus the first row from `start` on, in the direction of `step`, that can take focus,
 * mounting it first when it is outside the virtual window. Entering a row going down lands on
 * its first stop, going up on its last. Returns the thread it landed on, if any.
 */
export async function focusRowFrom(options: {
  viewport: HTMLElement | null;
  rows: readonly { item: HomeRow; phase: string }[];
  start: number;
  step: number;
  mount(index: number): void;
}): Promise<string | undefined> {
  const { viewport, rows, step } = options;
  if (!viewport) return undefined;
  for (let index = options.start; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];
    if (!row || !focusable(row)) continue;
    options.mount(index);
    // Scrolling an offscreen virtual row mounts it on the next browser frame.
    if (!viewport.querySelector(`[data-index="${index}"]`))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const links = [
      ...(viewport
        .querySelector(`[data-index="${index}"]`)
        ?.querySelectorAll<HTMLElement>(rowFocusSelector) ?? []),
    ];
    const next = step > 0 ? links[0] : links.at(-1);
    if (!next) continue;
    next.focus();
    return homeRowThread(row.item);
  }
  return undefined;
}

/**
 * Type to jump: the next row after `current` (wrapping round) whose title starts with
 * `letter`, as other lists do. Rows without a title (headings, Unsent) are passed over.
 */
export function typeAheadIndex(
  titles: readonly (string | undefined)[],
  current: number,
  letter: string,
): number | undefined {
  const wanted = letter.toLowerCase();
  for (let step = 1; step <= titles.length; step++) {
    const index = (current + step) % titles.length;
    if (titles[index]?.trim().toLowerCase().startsWith(wanted)) return index;
  }
  return undefined;
}
