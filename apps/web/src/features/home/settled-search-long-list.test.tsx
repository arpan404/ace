import { seedSettledThreads } from "@ace/fake-daemon";
import { configure, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { oneLineRow, openThreadsTab, pressEnd, rowsHeld } from "@/test/list-end.ts";
import { openPanelSearch } from "@/test/panel-search.ts";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 20000 });
useScrollLayout({ viewport: 600, row: oneLineRow });

const hangs = () => new Promise<void>(() => {});
const fails = () => Promise.reject(new Error("offline"));

test.each([
  { page: "hangs", answer: hangs },
  { page: "fails", answer: fails },
])(
  "a search's settled matches page in as the end scrolls into view while the daemon's page $page",
  async ({ answer }) => {
    const app = harness();
    seedSettledThreads(app.daemon, 300);
    // The daemon's next page never comes: only the search's own matches can fill the list.
    const paging = vi.spyOn(app.client, "threadsMore").mockImplementation(answer);
    try {
      const list = await openThreadsTab(app, /^Settled/);
      await within(list).findByRole("button", { name: /^(Loading…|Couldn't load. Try again)$/ });
      expect(await rowsHeld(list)).toBe(21);
      await userEvent.type(await openPanelSearch("Search threads"), "long ago");
      // The daemon's search finds up to 100 settled threads, more than the 20 loaded: the list
      // shows its first 50 matches and the foot.
      await waitFor(async () => expect(await rowsHeld(list)).toBe(51));
      // The end scrolled into view shows the next matches, with no button pressed.
      await pressEnd(list, /^Settled long ago (\d+)/);
      expect(await rowsHeld(list)).toBeGreaterThan(51);
      // Scrolling never asks the daemon again: after a failed page only Show more retries it.
      expect(paging).toHaveBeenCalledTimes(1);
    } finally {
      paging.mockRestore();
    }
  },
  40_000,
);
