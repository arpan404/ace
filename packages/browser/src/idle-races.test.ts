import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FakeHeadless } from "./backend-test-support.ts";
import type { BackendOpen, BrowserBackendSession } from "./backend.ts";
import { BrowserService, connectBrowser } from "./index.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A headless backend with two tabs, `a` (shown) and `b`, that can rest. It writes down, in
 * order, each tab hiding, showing, freezing and thawing, and each time a command reads the page
 * (`use`, an accessibility snapshot) or a recording takes its first picture (`picture`). Replies
 * to a step the test holds wait until the test releases them.
 */
class RestingTabs extends FakeHeadless {
  readonly log: string[] = [];
  private gates = new Map<string, PromiseWithResolvers<void>>();
  /** Holds the next `step` (such as `hide a`) until the returned function is called. */
  hold(step: string): () => void {
    const gate = Promise.withResolvers<void>();
    this.gates.set(step, gate);
    return () => gate.resolve();
  }
  private async step(step: string): Promise<void> {
    const gate = this.gates.get(step);
    this.gates.delete(step);
    if (gate) await gate.promise;
    this.log.push(step);
  }
  override async open(request: BackendOpen): Promise<BrowserBackendSession> {
    const hidden = new Set<string>();
    const pages = new Map<string, BrowserBackendSession>();
    for (const id of ["a", "b"]) {
      const page = await super.open(request);
      const send = page.cdp.send.bind(page.cdp);
      page.cdp.send = async (method, params) => {
        if (method === "Page.setWebLifecycleState")
          await this.step(`${params?.["state"] === "frozen" ? "freeze" : "thaw"} ${id}`);
        if (method === "Accessibility.getFullAXTree") this.log.push(`use ${id}`);
        return send(method, params);
      };
      page.screenshot = async () => {
        this.log.push(`picture ${id}`);
        return Buffer.from([0]);
      };
      pages.set(id, page);
    }
    const first = pages.get("a");
    if (!first) throw new Error("No first tab");
    return {
      ...first,
      tabs: {
        list: () => [...pages.keys()].map((tabId) => ({ tabId, url: "about:blank", title: "" })),
        active: () => "a",
        open: async () => "a",
        switch: async () => {},
        close: async () => {},
        dialog: () => undefined,
        answer: async () => {},
        page: (tabId) => {
          const page = pages.get(tabId);
          if (!page) throw new Error("No such tab");
          return page;
        },
        // As ace's Chrome: asking for the state a tab is already in changes nothing.
        rest: async (tabId, resting) => {
          if (hidden.has(tabId) === resting) return;
          await this.step(`${resting ? "hide" : "show"} ${tabId}`);
          if (resting) hidden.add(tabId);
          else hidden.delete(tabId);
        },
        resting: (tabId) => hidden.has(tabId),
      },
    };
  }
}

async function idleThread() {
  const home = await mkdtemp(join(tmpdir(), "ace-idle-races-"));
  const clock = { now: 0 };
  const ticks: (() => void)[] = [];
  const backend = new RestingTabs();
  const service = new BrowserService({
    dataDir: home,
    headlessBackend: backend,
    backendPreference: () => "headless",
    wakeWatch: false,
    ffmpeg: "/nonexistent",
    now: () => clock.now,
    tabLifecycle: {
      policy: defaultTabLifecycle,
      every: 60_000,
      set: (_delay, work) => {
        ticks.push(work);
        return () => {};
      },
    },
  });
  cleanups.push(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  /** Time passes untouched, then the lifecycle timer fires; resolves once it armed the next. */
  const idleFor = async (milliseconds: number) => {
    clock.now += milliseconds;
    const tick = ticks.shift();
    if (!tick) throw new Error("No lifecycle timer armed");
    tick();
    await expect.poll(() => ticks.length).toBe(1);
  };
  /** Starts the timer's look without waiting for it. */
  const lookAfter = (milliseconds: number) => {
    clock.now += milliseconds;
    ticks.shift()?.();
  };
  const use = (tabId: string) => service.execute("thread", { action: "snapshot", tabId });
  const lifecycle = (tabId: string) =>
    service.state("thread").tabs?.find((tab) => tab.tabId === tabId)?.lifecycle ?? "live";
  return { service, backend, clock, ticks, idleFor, lookAfter, use, lifecycle };
}

/** Lets pending callbacks run, so a held step is reached. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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
