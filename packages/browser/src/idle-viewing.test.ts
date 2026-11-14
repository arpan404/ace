import { expect, it } from "vitest";
import { capture, idleThread, settle, watch } from "./idle-test-support.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

const person = { kind: "human", connectionId: "viewer" } as const;
const select = (t: Awaited<ReturnType<typeof idleThread>>, tabId: string) =>
  t.service.execute("thread", { action: "tabs", operation: "select", tabId }, person);
/** The live capture opened on a tab's current page, if any. */
const captureOf = (t: Awaited<ReturnType<typeof idleThread>>, tabId: string) =>
  t.backend.captures.find(
    (opened) => !opened.closed && opened.page === t.backend.tabPages.get(tabId)?.cdp,
  );

it("a person switching to a frozen tab whose window will not show yet gets it once a retry works, the browser never paused", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.freezeAfterMs);
  await watch(t.service);
  await expect.poll(() => t.lifecycle("a")).toBe("live");

  t.backend.fail("show b");
  await select(t, "b");
  await expect
    .poll(() => t.service.state("thread").video)
    .toMatchObject({ status: "retrying", attempts: 1 });
  expect(t.service.state("thread")).toMatchObject({ status: "ready", activeTabId: "b" });

  t.navigationClock.advance(1_000);
  await expect.poll(() => t.backend.steps("b")).toEqual(["hide b", "freeze b", "show b", "thaw b"]);
  await expect.poll(() => captureOf(t, "b")).toBeDefined();
  expect(t.service.state("thread").video).toBeUndefined();
  expect(t.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  expect(t.lifecycle("b")).toBe("live");
});

it("a watched tab that never comes back pauses the browser with the reason after a bounded number of tries, and Reopen brings it back", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  t.backend.fail("show a", 100);
  await watch(t.service);
  await expect.poll(() => t.service.state("thread").video?.attempts).toBe(1);
  for (const [wait, attempts] of [
    [1_000, 2],
    [2_000, 3],
    [4_000, 4],
    [8_000, 5],
  ] as const) {
    t.navigationClock.advance(wait);
    await expect.poll(() => t.service.state("thread").video?.attempts).toBe(attempts);
  }
  // The sixth failure gives up: a paused browser that says why, no longer retrying.
  t.navigationClock.advance(16_000);
  await expect.poll(() => t.service.state("thread").status).toBe("paused");
  expect(t.service.state("thread").reason).toContain("could not be shown");
  expect(t.service.state("thread").video).toBeUndefined();
  expect(t.backend.tried.get("show a")).toBe(6);
  t.navigationClock.advance(120_000);
  await settle();
  expect(t.backend.tried.get("show a")).toBe(6);

  // Reopen: the thread's tabs open afresh, shown and running.
  await t.service.open({ threadId: "thread", workspaceId: "workspace" });
  await expect.poll(() => t.service.state("thread").status).toBe("ready");
  expect(t.service.state("thread").tabs?.map((tab) => tab.tabId)).toEqual(["a", "b"]);
});

it("an agent working in a tab someone keeps watching never stops, reopens or re-keys its video", async () => {
  const t = await idleThread();
  const viewer = await watch(t.service);
  const playing = await capture(t.backend, 0);
  playing.send(1, true);
  await expect.poll(() => viewer.chunks.length).toBe(1);
  const keyframes = playing.opened.keyframes;
  for (let command = 0; command < 5; command++) {
    await t.use("a");
    await t.idleFor(defaultTabLifecycle.restAfterMs);
    playing.send(command + 2, false);
  }
  await expect.poll(() => viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2, 3, 4, 5, 6]);
  expect(t.backend.captures).toHaveLength(1);
  expect(playing.opened.closed).toBe(false);
  expect(playing.opened.keyframes).toBe(keyframes);
  expect(t.backend.steps("a").filter((step) => !step.startsWith("use"))).toEqual([]);
});

it("two viewers with different backlogs both lose what was queued when a restore starts, and each starts again at a keyframe", async () => {
  const t = await idleThread();
  const hidden = t.backend.hold("hide a");
  t.lookAfter(defaultTabLifecycle.restAfterMs);
  await settle();
  const caughtUp = await watch(t.service, "caught-up");
  const behind = await watch(t.service, "behind");
  const before = await capture(t.backend, 0);
  before.send(1, true);
  await expect.poll(() => caughtUp.chunks.length + behind.chunks.length).toBe(2);
  await caughtUp.ack(caughtUp.chunks.at(-1)?.sequence ?? 0);
  // The second viewer's link pushes back: its chunks wait in its queue.
  behind.link.blocked = true;
  for (let marker = 2; marker < 6; marker++) before.send(marker, false);
  await expect.poll(() => caughtUp.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2, 3, 4, 5]);
  expect(behind.chunks.map((chunk) => chunk.bytes[0])).toEqual([1]);

  hidden();
  const after = await capture(t.backend, 1);
  expect(before.opened.closed).toBe(true);
  behind.link.blocked = false;
  after.send(6, false);
  after.send(7, true);
  await expect
    .poll(() => [caughtUp.chunks.at(-1)?.bytes[0], behind.chunks.at(-1)?.bytes[0]])
    .toEqual([7, 7]);
  // Nothing queued from before the restore arrived, and no delta came before the keyframe.
  expect(caughtUp.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2, 3, 4, 5, 7]);
  expect(behind.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 7]);
});

it("a viewer who leaves and comes back while the tab is being shown gets it once, at a keyframe", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  const showing = t.backend.hold("show a");
  const first = await watch(t.service, "first");
  await settle();
  first.leave();
  const back = await watch(t.service, "back");
  await settle();
  showing();
  const opened = await capture(t.backend, 0);
  opened.send(1, false);
  opened.send(2, true);
  await expect.poll(() => back.chunks.map((chunk) => chunk.bytes[0])).toEqual([2]);
  expect(t.backend.steps("a")).toEqual(["hide a", "show a"]);
  expect(t.service.state("thread").video).toBeUndefined();
  expect(first.chunks).toEqual([]);
});

it("a dropped tab the person switches to while watching reopens at its address and its video comes from the new page", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.discardAfterMs);
  expect(t.lifecycle("b")).toBe("discarded");
  const dropped = t.backend.tabPages.get("b")?.cdp;
  await watch(t.service);

  await select(t, "b");
  await expect.poll(() => t.backend.steps("b")).toEqual(["discard b", "revive b"]);
  const reopened = t.backend.tabPages.get("b")?.cdp;
  expect(reopened).not.toBe(dropped);
  await expect.poll(() => captureOf(t, "b")?.page).toBe(reopened);
  const tab = t.service.state("thread").tabs?.find((entry) => entry.tabId === "b");
  expect(tab).toMatchObject({ url: "https://b.test/", lifecycle: "live", pageStateLost: true });
  expect(t.service.state("thread")).toMatchObject({ status: "ready", activeTabId: "b" });
});
