import { longHistory } from "@ace/fake-daemon";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

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
  await within(feed).findByText("Question 366: what does route 366 render?");
  await screen.findByRole("status", { name: "Jumped" });
  // jsdom's tall viewport exposes the first row even after the page merges. Loading
  // itself must not keep chaining through all 400 turns while the reader is still.
  expect(within(feed).queryByText("Question 365: what does route 365 render?")).toBeNull();
  expect(within(feed).getByText("Question 400: what does route 400 render?")).toBeTruthy();
  fireEvent.wheel(viewport, { deltaY: -100 });
  expect(await within(feed).findByText("Question 316: what does route 316 render?")).toBeTruthy();
});
