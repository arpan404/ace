import { facts } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const pill = () => screen.queryByRole("button", { name: /^Scroll to end/ });

/** A thread with one ask and a short reply, its viewport given a measured size. */
async function open(size: { content: () => number; view: number }) {
  const app = harness();
  app.daemon.createThread({ id: "pill", workspaceId: "ace", title: "Pill", provider: "codex" });
  app.daemon.apply("pill", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the output"),
    facts.message("root", "reply", "assistant", "Done."),
  ]);
  await app.open("/t/pill");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Done.");
  const viewport = feed.closest<HTMLElement>("[data-virtual-viewport]");
  if (!viewport) throw new Error("Missing transcript viewport");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: size.content },
    clientHeight: { configurable: true, value: size.view },
  });
  return { app, feed, viewport };
}

test("a wheel nudge on a short thread with no scrollbar never shows Scroll to end", async () => {
  const { app, feed, viewport } = await open({ content: () => 480, view: 600 });
  fireEvent.wheel(viewport, { deltaY: -12 });
  fireEvent.scroll(viewport);
  fireEvent.wheel(viewport, { deltaY: -40 });
  expect(pill()).toBeNull();

  // Still following: a reply arriving afterwards brings no pill either.
  act(() => app.daemon.apply("pill", [facts.message("root", "more", "assistant", "One more.")]));
  await within(feed).findByText("One more.");
  expect(pill()).toBeNull();
});

test("scrolling 500px up a long thread shows Scroll to end, and coming back hides it", async () => {
  const { viewport } = await open({ content: () => 4_000, view: 600 });
  const end = 4_000 - 600;
  viewport.scrollTop = end;
  fireEvent.scroll(viewport);

  fireEvent.wheel(viewport, { deltaY: -500 });
  viewport.scrollTop = end - 500;
  fireEvent.scroll(viewport);
  expect(await screen.findByRole("button", { name: /^Scroll to end/ })).toBeTruthy();

  // Back within a couple of lines of the end: following resumes and the pill goes.
  fireEvent.wheel(viewport, { deltaY: 480 });
  viewport.scrollTop = end - 20;
  fireEvent.scroll(viewport);
  await waitFor(() => expect(pill()).toBeNull());
});
