import { seedSettledThreads } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { pressEnd, pressEndUntil } from "@/test/list-end.ts";
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

test("Settled keeps paging older threads in as its end scrolls into view, past its first page", async () => {
  const app = harness();
  seedSettledThreads(app.daemon, 200);
  const list = await openTab(app, /^Settled/);
  const first = await within(list).findAllByRole("link", { name: /^Settled long ago \d+/ });
  const top = Number(/(\d+)/.exec(first[0]?.getAttribute("aria-label") ?? "")?.[1]);
  // 50 show at first. Each End brings the list's end into view and the next page follows, from
  // what is loaded and then from the daemon (20 a page), with no button pressed.
  await pressEndUntil(list, /^Settled long ago (\d+)/, (n) => Math.abs(n - top) >= 100);
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
  const height = () => Number.parseFloat(list.style.height);
  const viewport = list.closest<HTMLElement>("[data-virtual-viewport]");
  if (!viewport) throw new Error("No list viewport");
  // One scroll to the end brings one page, 100 of the 120, and the rest wait for the next.
  const first = height();
  act(() => {
    viewport.scrollTop = first;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await waitFor(() => expect(height()).toBeGreaterThan(first));
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
  const second = height();
  expect(await pressEndUntil(list, /^Napping (\d+)/, (n) => n === 120)).toBe(120);
  const last = height();
  // The first page more brought 50 rows and the last the remaining 20, about two fifths as much:
  // two pages at once would leave the last next to nothing.
  expect(last - second).toBeGreaterThan((second - first) / 5);
  expect(last - second).toBeLessThan(second - first);
}, 40_000);

test("a search's settled matches page in as the end scrolls into view while the daemon's page hangs", async () => {
  const app = harness();
  seedSettledThreads(app.daemon, 300);
  // The daemon's next page never comes: only the search's own matches can fill the list.
  const paging = vi.spyOn(app.client, "threadsMore").mockReturnValue(new Promise(() => {}));
  try {
    const list = await openTab(app, /^Settled/);
    const height = () => Number.parseFloat(list.style.height);
    await within(list).findByRole("button", { name: "Loading…" });
    const loaded = height();
    await userEvent.click(screen.getByRole("button", { name: "Search threads" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search threads" }), "long ago");
    // The daemon's search finds up to 100 settled threads, more than the 20 loaded: the list
    // grows to its first 50 and holds there.
    let page = 0;
    await waitFor(async () => {
      page = height();
      expect(page).toBeGreaterThan(loaded * 2);
      await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
      expect(height()).toBe(page);
    });
    // The end scrolled into view shows the next 50 matches, with no button pressed.
    await waitFor(
      async () => {
        await pressEnd(list, /^Settled long ago (\d+)/);
        expect(height()).toBeGreaterThan(page * 1.5);
      },
      { timeout: 10_000, interval: 100 },
    );
  } finally {
    paging.mockRestore();
  }
}, 40_000);
