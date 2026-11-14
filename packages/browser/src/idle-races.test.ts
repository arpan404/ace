import { afterEach, expect, it } from "vitest";
import { connectBrowser } from "./index.ts";
import { idleThread, settle } from "./idle-test-support.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

it("a command arriving while its tab is being frozen runs only once the tab is awake again", async () => {
  const t = await idleThread();
  const release = t.backend.hold("hide a");
  t.lookAfter(defaultTabLifecycle.freezeAfterMs);
  await settle();
  const used = t.use("a");
  await settle();
  release();
  await used;
  expect(t.backend.log.filter((step) => step.endsWith(" a"))).toEqual([
    "hide a",
    "freeze a",
    "show a",
    "thaw a",
    "use a",
  ]);
  expect(t.lifecycle("a")).toBe("live");
});

it("a tab used while another tab's change is applying is not frozen from what was seen before", async () => {
  const t = await idleThread();
  const release = t.backend.hold("hide a");
  t.lookAfter(defaultTabLifecycle.freezeAfterMs);
  await settle();
  // Tab b is used meanwhile: it is active again by the time its turn comes.
  await t.use("b");
  release();
  await expect.poll(() => t.ticks.length).toBe(1);
  expect(t.backend.log.filter((step) => step.endsWith(" b"))).toEqual(["use b"]);
  expect(t.lifecycle("b")).toBe("live");
});

it("a viewer and a command arriving during a slow hide both wait until the tab is shown", async () => {
  const t = await idleThread();
  const release = t.backend.hold("hide a");
  t.lookAfter(defaultTabLifecycle.restAfterMs);
  await settle();
  const bridge = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    sendStream: () => true,
  });
  cleanups.push(async () => bridge.close());
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { width: 640, height: 400, devicePixelRatio: 1 },
    video: { codecs: ["vp8"] },
  });
  const used = t.use("a");
  await settle();
  expect(t.backend.log.filter((step) => step.endsWith(" a"))).toEqual([]);
  release();
  await used;
  expect(t.backend.log.filter((step) => step.endsWith(" a"))).toEqual([
    "hide a",
    "show a",
    "use a",
  ]);
});

it.each([
  ["rested", defaultTabLifecycle.restAfterMs, ["hide a", "show a", "picture a"]],
  [
    "frozen",
    defaultTabLifecycle.freezeAfterMs,
    ["hide a", "freeze a", "show a", "thaw a", "picture a"],
  ],
])(
  "a recording of a %s tab nobody watches starts on a shown, running page",
  async (_, idle, steps) => {
    const t = await idleThread();
    await t.idleFor(idle);
    await t.service.startRecording("thread");
    expect(t.backend.log.filter((step) => step.endsWith(" a"))).toEqual(steps);
    expect(t.lifecycle("a")).toBe("live");
  },
);
