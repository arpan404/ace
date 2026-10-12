import { homeRowThread, type HomeRow } from "@ace/ui-core";

export const rowFocusSelector = "[data-row-focus], [data-section-toggle]";

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
