import { seedSettledThreads, workbench } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 20000 });
useScrollLayout({ viewport: 600, row: 58 });

const total = 2_000;

/** History of a daemon holding 2,000 settled threads, paged in as the list reaches its end. */
async function open() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedSettledThreads(app.daemon, total);
  await app.open("/history");
  const main = await screen.findByRole("main");
  const list = await within(main).findByRole("list", { name: "Settled threads" });
  await within(list).findByRole("link", { name: /^Settled long ago 0001/ });
  return { main, list };
}

/** Press End from a row in view; the number of the settled thread it lands on. */
async function end(list: HTMLElement): Promise<number> {
  // A row that scrolled out unmounts and takes focus with it: start again from one in view.
  const active = document.activeElement;
  const from =
    active instanceof HTMLElement && list.contains(active)
      ? active
      : list.querySelector<HTMLElement>("[data-view-row]");
  if (!from) throw new Error("No rows");
  act(() => from.focus());
  fireEvent.keyDown(from, { key: "End" });
  return waitFor(() => {
    const label = document.activeElement?.getAttribute("aria-label") ?? "";
    const number = /^Settled long ago (\d+)/.exec(label)?.[1];
    if (!number || document.activeElement === from) throw new Error("End hasn't landed yet");
    return Number(number);
  });
}

test("settled threads keep paging in as End reaches the last, mounting only a window", async () => {
  const { list } = await open();
  // Without an observer older pages load in turn; End lands on the last loaded so far.
  let reached = 0;
  await waitFor(
    async () => {
      reached = await end(list);
      expect(reached).toBeGreaterThan(300);
    },
    { timeout: 20_000, interval: 100 },
  );
  expect(within(list).queryByRole("link", { name: /^Settled long ago 0001/ })).toBeNull();
  const links = within(list).getAllByRole("link");
  expect(links.length).toBeGreaterThan(5);
  expect(links.length).toBeLessThan(40);
  // ↑ steps to the one above, and more pages still arrive below.
  fireEvent.keyDown(document.activeElement ?? list, { key: "ArrowUp" });
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(
      new RegExp(`^Settled long ago ${String(reached - 1).padStart(4, "0")}`),
    ),
  );
  await waitFor(async () => expect(await end(list)).toBeGreaterThan(reached), {
    timeout: 10_000,
    interval: 100,
  });
}, 40_000);

test("searching 2,000 settled threads finds one far down the list", async () => {
  const { main, list } = await open();
  await userEvent.type(within(main).getByRole("searchbox", { name: "Search history" }), "1777");
  expect(await within(list).findByRole("link", { name: /^Settled long ago 1777/ })).toBeTruthy();
}, 40_000);
