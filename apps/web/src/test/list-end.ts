import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import type { harness } from "./harness.tsx";

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

/**
 * The Threads panel's estimate for a one-line row (Snoozed, Settled, a chat). A test that lays
 * every row out this tall (`useScrollLayout`) can count a list's rows by its height.
 */
export const oneLineRow = 38;

/** How many rows a list of one-line rows holds, its foot counted, once it stops changing. */
export async function rowsHeld(list: HTMLElement): Promise<number> {
  const rows = () => Math.round((Number.parseFloat(list.style.height) - 16) / oneLineRow);
  let held = 0;
  await waitFor(async () => {
    held = rows();
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(rows()).toBe(held);
  });
  return held;
}

/** The Threads panel on its `tab`, with the list that tab draws. */
export async function openThreadsTab(
  app: ReturnType<typeof harness>,
  tab: RegExp,
): Promise<HTMLElement> {
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await userEvent.click(await nav.findByRole("tab", { name: tab }));
  return nav.findByRole("list", { name: "Threads" });
}
