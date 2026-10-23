import { longHistory } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { gestureWindowMs } from "./transcript/use-history-paging.ts";

beforeEach(() => localStorage.clear());

test("one upward scroll prefetches one older page without the reply paging the rest of the thread", async () => {
  const app = harness({ snapshotItems: 20 });
  app.play(longHistory(400)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Question 400: what does route 400 render?");
  expect(within(feed).queryByText("Question 366: what does route 366 render?")).toBeNull();
  const viewport = feed.closest("[data-virtual-viewport]");
  if (!viewport) throw new Error("No transcript viewport");
  fireEvent.wheel(viewport, { deltaY: -100 });
  // One page: the 199 items before the 20 shown (one long turn, so the page's size cuts it).
  await within(feed).findByText("Question 292: what does route 292 render?");
  // Paging older history is seamless: no overlay bar appears at the top.
  expect(screen.queryByRole("status", { name: "Jumped" })).toBeNull();
  // jsdom's tall viewport exposes the first row even after the page merges. Loading
  // itself must not keep chaining through all 400 turns while the reader is still.
  expect(within(feed).queryByText("Question 291: what does route 291 render?")).toBeNull();
  expect(within(feed).getByText("Question 400: what does route 400 render?")).toBeTruthy();
  fireEvent.wheel(viewport, { deltaY: -100 });
  expect(await within(feed).findByText("Question 192: what does route 192 render?")).toBeTruthy();
});

test("a scroll long after the reader's last gesture never pages older history", async () => {
  const app = harness({ snapshotItems: 20 });
  app.play(longHistory(400)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Question 400: what does route 400 render?");
  const viewport = feed.closest("[data-virtual-viewport]");
  if (!viewport) throw new Error("No transcript viewport");
  // The reader scrolls up, far from the top: nothing to page yet.
  viewport.scrollTop = 5_000;
  fireEvent.wheel(viewport, { deltaY: -100 });
  fireEvent.scroll(viewport);
  // Later, with no gesture, something above resizes and the view lands near the top.
  await act(() => new Promise((resolve) => setTimeout(resolve, gestureWindowMs + 100)));
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(within(feed).queryByText("Question 366: what does route 366 render?")).toBeNull();
  // The reader's own gesture there pages at once.
  fireEvent.wheel(viewport, { deltaY: -100 });
  expect(await within(feed).findByText("Question 366: what does route 366 render?")).toBeTruthy();
});

test("a fitting snapshot pages older history on wheel alone", async () => {
  const app = harness({ snapshotItems: 20 });
  app.play(longHistory(400)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Question 400: what does route 400 render?");
  const viewport = feed.closest("[data-virtual-viewport]");
  if (!viewport) throw new Error("No transcript viewport");
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 1000 },
    scrollHeight: {
      configurable: true,
      get: () => Number.parseFloat(feed.style.height) || 840,
    },
  });
  expect(viewport.scrollHeight).toBeGreaterThan(0);
  expect(viewport.scrollHeight).toBeLessThan(viewport.clientHeight);
  fireEvent.wheel(viewport, { deltaY: -100 });
  await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
  expect(within(feed).getByText("Question 400: what does route 400 render?")).toBeTruthy();
  // The page is above the held view. Read its first question through the viewport.
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  await within(feed).findByText("Question 292: what does route 292 render?");
  expect(within(feed).queryByText("Question 291: what does route 291 render?")).toBeNull();
});
