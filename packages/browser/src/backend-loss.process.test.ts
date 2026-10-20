import { once } from "node:events";
import { expect, it, vi } from "vitest";
import type { BrowserBackendLost } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";

it("a detached desktop view rejects its pending read and reopens on the surviving desktop without losing its sibling", async () => {
  const f = await backendFixture({ backendLoss: () => "headless" });
  await f.open("lost");
  await f.service.execute("lost", { action: "navigate", url: "http://localhost:3000/lost" });
  await f.open("healthy");
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing lost view");
  const ready = Promise.withResolvers<void>();
  const events: BrowserBackendLost[] = [];
  f.service.subscribe(
    "lost",
    "viewer",
    { send: () => true },
    (state) => {
      if (state.backend === "embedded" && state.status === "ready" && state.pageStateLost)
        ready.resolve();
    },
    (event) => {
      if (event.type === "browser.backend.lost") events.push(event);
    },
  );
  f.hold("Accessibility.getFullAXTree");
  const entered = once(f.requests, "Accessibility.getFullAXTree");
  const rejected = expect(f.service.execute("lost", { action: "snapshot" })).rejects.toThrow(
    "view closed",
  );
  await entered;
  f.hold("");
  f.sendEvent(sessionId, "Inspector.detached", { reason: "target_closed" });
  await rejected;
  await ready.promise;
  expect(f.service.state("lost")).toMatchObject({
    backend: "embedded",
    status: "ready",
    url: "http://localhost:3000/lost",
    pageStateLost: true,
  });
  await f.service.execute("healthy", { action: "navigate", url: "http://localhost:3000/healthy" });
  expect(f.service.state("healthy")).toMatchObject({
    backend: "embedded",
    status: "ready",
    url: "http://localhost:3000/healthy",
  });
  // Late traffic from the removed target cannot log or trigger a second recovery.
  f.sendEvent(sessionId, "Inspector.detached", {});
  await f.service.execute("healthy", { action: "screenshot" });
  expect(events).toHaveLength(1);
  expect(f.headless.pages).toHaveLength(0);
});

it("a dropped desktop link reports the page lost only once the desktop has had its chance to come back", async () => {
  const f = await backendFixture({ backendLoss: () => "pause", desktopReadoptionGraceMs: 300 });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const events: BrowserBackendLost[] = [];
  f.service.subscribe(
    "thread",
    "viewer",
    { send: () => true },
    () => {},
    (event) => {
      if (event.type === "browser.backend.lost") events.push(event);
    },
  );
  await f.disconnect();
  // Paused, but nothing is said to be lost while the desktop may still hand the view back.
  expect(f.service.state("thread")).toMatchObject({ status: "paused" });
  expect(f.service.state("thread").pageStateLost).toBeUndefined();
  expect(events).toEqual([]);
  // An agent asking for the page meanwhile waits out the grace instead of moving the page.
  const resumed = f.service.open({
    threadId: "thread",
    workspaceId: "workspace-thread",
    background: true,
  });
  expect(f.headless.pages).toHaveLength(0);
  await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 5_000 });
  expect(events[0]).toMatchObject({ url: "http://localhost:3000/page", pageStateLost: true });
  await resumed;
  expect(f.service.state("thread")).toMatchObject({
    backend: "headless",
    status: "ready",
    url: "http://localhost:3000/page",
    pageStateLost: true,
  });
});
