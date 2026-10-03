import { once } from "node:events";
import { expect, it } from "vitest";
import type { BrowserBackendLost } from "@ace/protocol";
import { backendFixture } from "./backend-test-support.ts";

it("a detached desktop view rejects its pending read and recovers without losing its sibling", async () => {
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
      if (state.backend === "headless" && state.status === "ready") ready.resolve();
    },
    (event) => events.push(event),
  );
  f.hold("Accessibility.getFullAXTree");
  const entered = once(f.requests, "Accessibility.getFullAXTree");
  const rejected = expect(f.service.execute("lost", { action: "snapshot" })).rejects.toThrow(
    "view closed",
  );
  await entered;
  f.sendEvent(sessionId, "Inspector.detached", { reason: "target_closed" });
  await rejected;
  await ready.promise;
  expect(f.service.state("lost")).toMatchObject({
    backend: "headless",
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
  expect(f.headless.pages).toHaveLength(1);
});

it("desktop disconnection still emits loss and recovers after a controller lease error paused the page", async () => {
  const f = await backendFixture({ backendLoss: () => "headless" });
  await f.open();
  await f.service.execute("thread", { action: "navigate", url: "http://localhost:3000/page" });
  const paused = Promise.withResolvers<void>(),
    ready = Promise.withResolvers<void>();
  const events: BrowserBackendLost[] = [];
  f.service.subscribe(
    "thread",
    "viewer",
    { send: () => true },
    (state) => {
      if (state.status === "paused" && state.reason === "Lease refused") paused.resolve();
      if (state.status === "ready" && state.backend === "headless") ready.resolve();
    },
    (event) => events.push(event),
  );
  f.failController("Lease refused");
  f.service.takeover("thread", "human");
  await paused.promise;
  expect(events).toEqual([]);
  await f.disconnect();
  await ready.promise;
  expect(events).toEqual([
    expect.objectContaining({
      threadId: "thread",
      recovery: "headless",
      url: "http://localhost:3000/page",
      reason: "Desktop disconnected",
    }),
  ]);
  expect(f.service.state("thread")).toMatchObject({
    backend: "headless",
    status: "ready",
    controller: "human",
    owner: "human",
    pageStateLost: true,
  });
  await f.service.input("thread", { kind: "key", event: "char", key: "x" }, "human");
  expect(f.headless.pages[0]?.text).toBe("x");
});
