import { seedSettledThreads } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { act, configure, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { oneLineRow, openThreadsTab, pressEndUntil, rowsHeld } from "@/test/list-end.ts";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 20000 });
useScrollLayout({ viewport: 600, row: oneLineRow });

const minute = 60_000;
const pad = (n: number) => String(n).padStart(4, "0");

test("Settled keeps paging older threads in as its end scrolls into view, past its first page", async () => {
  const app = harness();
  seedSettledThreads(app.daemon, 200);
  const list = await openThreadsTab(app, /^Settled/);
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
  const list = await openThreadsTab(app, /^Snoozed/);
  await within(list).findByRole("link", { name: /^Napping 0001/ });
  // 50 and the foot at first; one scroll to the end brings one page more, and the rest wait for
  // the next.
  expect(await rowsHeld(list)).toBe(51);
  const viewport = list.closest<HTMLElement>("[data-virtual-viewport]");
  if (!viewport) throw new Error("No list viewport");
  act(() => {
    viewport.scrollTop = 51 * oneLineRow;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(await rowsHeld(list)).toBe(101);
  expect(await pressEndUntil(list, /^Napping (\d+)/, (n) => n === 120)).toBe(120);
  // All 120 show, and the foot is gone.
  expect(await rowsHeld(list)).toBe(120);
}, 40_000);
