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

it("a desktop that stopped answering, its liveness ping too, gets the page back on its own once it answers again", async () => {
  const clock = new TestNavigationClock();
  const f = await backendFixture({
    navigationClock: clock,
    wakeWatch: false,
    tabLifecycle: false,
    backendLoss: () => "pause",
  });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  // The desktop froze while its link stayed up.
  f.hold("Accessibility.getFullAXTree", "ace.ping");
  const asked = once(f.requests, "Accessibility.getFullAXTree");
  const failed = expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow(
    "timed out",
  );
  await asked;
  const pinged = once(f.requests, "ace.ping");
  clock.advance(30_000);
  await failed;
  await pinged;
  clock.advance(5_000);
  await vi.waitFor(() =>
    expect(f.service.state("thread")).toMatchObject({
      status: "paused",
      reason: "Desktop browser command timed out",
      pageStateLost: true,
    }),
  );
  f.releaseHold();
  await vi.waitFor(() => {
    clock.advance(1_000);
    expect(f.service.state("thread")).toMatchObject({
      backend: "embedded",
      status: "ready",
      url: "http://localhost:3000/page",
    });
  });
  expect(f.headless.pages).toHaveLength(0);
});

it("a page paused by a capture that timed out comes back on the desktop on its own", async () => {
  const { f, clock } = await stalledCapture();
  await vi.waitFor(() => {
    clock.advance(1_000);
    expect(f.service.state("thread")).toMatchObject({
      backend: "embedded",
      status: "ready",
      url: "http://localhost:3000/page",
    });
  });
  expect(f.headless.pages).toHaveLength(0);
});
