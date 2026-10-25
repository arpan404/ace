import { multiDayDemo } from "@ace/fake-daemon";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-multi-day";
const day = 24 * 60 * 60 * 1000;
const ask = (n: number) => `Migrate checkpoint ${n}, inspect files and report failures.`;

async function openJumped() {
  let now = 10 * day;
  const app = harness({ snapshotItems: 12, clock: () => (now += 1) });
  // Long enough that one newer page (199 items) still leaves a gap to live.
  const script = app.play(multiDayDemo(threadId, 30, { scans: 20 }));
  script.runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const viewport = feed.closest("[data-virtual-viewport]");
  if (!viewport) throw new Error("No transcript viewport");
  const user = userEvent.setup();
  const rail = await screen.findByRole("navigation", { name: "Conversation turns" });
  await user.click(within(rail).getByRole("button", { name: "Turn 1" }));
  expect(await within(feed).findByText(ask(1))).toBeTruthy();
  const gap = await screen.findByRole("group", { name: "Gap to live" });
  return { feed, viewport, gap };
}

const spinning = (gap: HTMLElement) => gap.querySelector('[data-slot="spinner"]') !== null;

test("scroll events without a gesture never page a jumped window newer", async () => {
  const { feed, viewport, gap } = await openJumped();
  const before = gap.textContent;
  // Code moving the view (a jump landing, a keep-place restore) fires scroll
  // events with no gesture behind them: none of them may page the window.
  fireEvent.scroll(viewport, {});
  fireEvent.scroll(viewport, {});
  fireEvent.scroll(viewport, {});
  expect(spinning(gap)).toBe(false);
  expect(gap.textContent).toBe(before);
  expect(within(feed).getByText(ask(1))).toBeTruthy();
});

test("one downward gesture pages a jumped window one step newer", async () => {
  const { viewport, gap } = await openJumped();
  const before = gap.textContent;
  expect(before).toMatch(/\d+ newer turns? until live/);
  fireEvent.wheel(viewport, { deltaY: 200 });
  // The gesture pages once: the gap to live shrinks instead of sticking.
  await waitFor(() => expect(gap.textContent).not.toBe(before));
  expect(gap.textContent).toMatch(/\d+ newer turns? until live/);
});
