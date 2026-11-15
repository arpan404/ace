import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";

/*
 * Scroll a virtual list to its end the way a person does by keyboard, for tests of lists that
 * page in more rows as their end comes into view. Needs `useScrollLayout`, so the list scrolls.
 */

/** Press End from a row in view; the number in the title of the last thread row it shows. */
export async function pressEnd(list: HTMLElement, title: RegExp): Promise<number> {
  // A row that scrolled out unmounts and takes focus with it: start again from one in view.
  const active = document.activeElement;
  const from =
    active instanceof HTMLElement && list.contains(active)
      ? active
      : list.querySelector<HTMLElement>("[data-row-focus]");
  if (!from) throw new Error("No rows");
  act(() => from.focus());
  fireEvent.keyDown(from, { key: "End" });
  return waitFor(() => {
    const last = within(list)
      .queryAllByRole("link")
      .map((link) => title.exec(link.getAttribute("aria-label") ?? "")?.[1])
      .findLast((number) => number !== undefined);
    if (!last) throw new Error("No thread row in view");
    return Number(last);
  });
}

/** Press End until the last row in view is numbered as `far` wants; the number it reached. */
export async function pressEndUntil(
  list: HTMLElement,
  title: RegExp,
  far: (reached: number) => boolean,
): Promise<number> {
  let reached = 0;
  await waitFor(
    async () => {
      reached = await pressEnd(list, title);
      expect(far(reached)).toBe(true);
    },
    { timeout: 20_000, interval: 100 },
  );
  return reached;
}
