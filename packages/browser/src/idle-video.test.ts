import { expect, it } from "vitest";
import { capture, idleThread, settle, watch } from "./idle-test-support.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

it("a running video stops while its tab is restored, sends nothing while the restore fails, and starts again at a keyframe", async () => {
  const t = await idleThread();
  // The tab starts to rest just as a person comes to watch it.
  const hidden = t.backend.hold("hide a");
  t.lookAfter(defaultTabLifecycle.restAfterMs);
  await settle();
  const viewer = await watch(t.service);
  const before = await capture(t.backend, 0);
  before.send(1, true);
  before.send(2, false);
  await expect.poll(() => viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2]);

  t.backend.fail("show a");
  hidden();
  await expect.poll(() => t.service.state("thread").video?.status).toBe("retrying");
  // The capture of the page being hidden ended; what it still sends, and acks, deliver nothing.
  expect(before.opened.closed).toBe(true);
  before.send(3, true);
  await viewer.ack(viewer.chunks.at(-1)?.sequence ?? 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2]);
  // Nor does any capture start while the page is still hidden.
  expect(t.backend.captures).toHaveLength(1);

  t.navigationClock.advance(1_000);
  const after = await capture(t.backend, 1);
  expect(t.backend.steps("a")).toEqual(["hide a", "show a"]);
  // A delta cannot be the first picture: the viewer starts at the new capture's keyframe.
  after.send(4, false);
  after.send(5, true);
  await expect.poll(() => viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2, 5]);
  expect(viewer.chunks.at(-1)?.key).toBe(true);
  expect(t.service.state("thread").video).toBeUndefined();
});

it("a viewer coming back to a frozen tab whose window will not show yet sees retrying, not a paused browser", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.freezeAfterMs);
  t.backend.fail("show a");
  await watch(t.service);
  await expect
    .poll(() => t.service.state("thread").video)
    .toMatchObject({ status: "retrying", attempts: 1 });
  expect(t.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  expect(t.lifecycle("a")).toBe("frozen");

  t.navigationClock.advance(1_000);
  await expect.poll(() => t.backend.steps("a")).toEqual(["hide a", "freeze a", "show a", "thaw a"]);
  await expect.poll(() => t.service.state("thread").video).toBeUndefined();
  expect(t.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  expect(t.lifecycle("a")).toBe("live");
  // The page is captured afresh once it runs again.
  await capture(t.backend, 0);
});

it("a wake that fails after the viewer left neither reports retrying nor tries again", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  const showing = t.backend.hold("show a");
  t.backend.fail("show a");
  const viewer = await watch(t.service);
  await settle();
  // The viewer leaves while the window is still being shown; the show then fails.
  viewer.leave();
  await settle();
  showing();
  await settle();
  expect(t.service.state("thread").video).toBeUndefined();
  t.navigationClock.advance(60_000);
  await settle();
  expect(t.backend.steps("a")).toEqual(["hide a"]);
});
