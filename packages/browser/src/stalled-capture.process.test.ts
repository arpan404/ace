import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";

/**
 * A desktop view that stops drawing (a frozen or hidden tab) never answers a screenshot, while
 * the desktop itself still answers its liveness ping. The capture that wanted the picture times
 * out and pauses the thread's browser. Opening the browser again, as the panel's Reopen does,
 * brings it back on the desktop.
 */
async function stalledCapture() {
  const clock = new TestNavigationClock();
  const f = await backendFixture({
    navigationClock: clock,
    wakeWatch: false,
    tabLifecycle: false,
    backendLoss: () => "pause",
  });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  f.hold("Page.captureScreenshot");
  const asked = once(f.requests, "Page.captureScreenshot");
  // A wake restarts the capture: its first picture never comes.
  f.service.wake();
  await asked;
  const pinged = once(f.requests, "ace.ping");
  clock.advance(30_000);
  await pinged;
  await vi.waitFor(() =>
    expect(f.service.state("thread")).toMatchObject({
      status: "paused",
      reason: "Desktop browser command timed out",
    }),
  );
  // The view draws again.
  f.releaseHold();
  return { f, clock };
}

it("Reopen brings back a page paused by a capture that timed out while the desktop still answered", async () => {
  const { f } = await stalledCapture();
  await f.open();
  expect(f.service.state("thread")).toMatchObject({
    backend: "embedded",
    status: "ready",
    url: "http://localhost:3000/page",
    pageStateLost: true,
  });
});

it("Reopen brings the page back even when its old view does not close in time", async () => {
  const { f, clock } = await stalledCapture();
  f.hold("close");
  const closing = once(f.requests, "close");
  const reopened = f.open();
  await closing;
  clock.advance(30_000);
  f.releaseHold();
  await reopened;
  expect(f.service.state("thread")).toMatchObject({ backend: "embedded", status: "ready" });
});
