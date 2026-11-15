import { seedSettledThreads } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 20000 });
useScrollLayout({ viewport: 600, row: 40 });

const minute = 60_000;
const pad = (n: number) => String(n).padStart(4, "0");

/** The Threads panel on its `tab`, with the list that tab draws. */
async function openTab(app: ReturnType<typeof harness>, tab: RegExp) {
  await app.open("/new");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await userEvent.click(await nav.findByRole("tab", { name: tab }));
  return nav.findByRole("list", { name: "Threads" });
}

/** Press End from a row in view; the number in the title of the last thread row it shows. */
async function end(list: HTMLElement, title: RegExp): Promise<number> {
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
async function scrollUntil(
  list: HTMLElement,
  title: RegExp,
  far: (reached: number) => boolean,
): Promise<number> {
  let reached = 0;
  await waitFor(
    async () => {
      reached = await end(list, title);
      expect(far(reached)).toBe(true);
    },
    { timeout: 20_000, interval: 100 },
  );
  return reached;
}

test("Settled keeps paging older threads in as its end scrolls into view, past its first page", async () => {
  const app = harness();
  seedSettledThreads(app.daemon, 300);
  const list = await openTab(app, /^Settled/);
  const first = await within(list).findAllByRole("link", { name: /^Settled long ago \d+/ });
  const top = Number(/(\d+)/.exec(first[0]?.getAttribute("aria-label") ?? "")?.[1]);
  // 50 show at first. Each End brings the list's end into view and the next page follows, from
  // what is loaded and then from the daemon, with no button pressed.
  await scrollUntil(list, /^Settled long ago (\d+)/, (n) => Math.abs(n - top) >= 150);
}, 40_000);

test("Snoozed shows more of its threads as its end scrolls into view, until the last", async () => {
  let now = Date.parse("2026-11-03T12:00:00Z");
  const app = harness({ clock: () => now, uiClock: () => now });
  for (let n = 1; n <= 120; n++) {
    const id = `thread-napping-${pad(n)}`;
    app.daemon.createThread(
      {
        id,
        workspaceId: WorkspaceId.parse("ace"),
        title: `Napping ${pad(n)}`,
        provider: "claude",
        hasSentMessage: true,
      },
      now - n * minute,
    );
    // The soonest to wake first: thread n wakes n hours from now.
    app.daemon.command({
      id: CommandId.parse(`snooze-${id}`),
      deviceId: DeviceId.parse("long-lists"),
      payload: {
        type: "thread.snooze",
        threadId: ThreadId.parse(id),
        until: now + n * 60 * minute,
      },
    });
  }
  now += 1;
  const list = await openTab(app, /^Snoozed/);
  await within(list).findByRole("link", { name: /^Napping 0001/ });
  expect(await scrollUntil(list, /^Napping (\d+)/, (n) => n === 120)).toBe(120);
}, 40_000);
