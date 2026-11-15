import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { FakeHeadless } from "./backend-test-support.ts";
import type {
  BackendOpen,
  BrowserBackendSession,
  BrowserCdp,
  CaptureEvents,
  VideoHost,
} from "./backend.ts";
import type { VideoEncode } from "./video-policy.ts";
import { BrowserService, connectBrowser } from "./index.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A headless backend with two tabs, `a` (shown) and `b`, that can rest. It writes down, in
 * order, each tab hiding, showing, freezing and thawing, each time a command reads the page
 * (`use`, an accessibility snapshot), a recording takes its first picture (`picture`), the page
 * prints (`print`) and the person's requests reach it (`certificate`, `files`, `auth`, `mute`).
 * A step the test holds waits until released; one it fails throws, as many times as asked.
 */
export class RestingTabs extends FakeHeadless {
  readonly log: string[] = [];
  private gates = new Map<string, PromiseWithResolvers<void>>();
  private failing = new Map<string, number>();
  /** The thread's open request: the page's own callbacks, such as `print`. */
  request: BackendOpen | undefined;
  /**
   * Every tab capture the live video opened, in order: the test makes its chunks (`events`)
   * and reads the encodes it was told to run.
   */
  readonly captures: {
    page: BrowserCdp;
    events: CaptureEvents;
    encodes: VideoEncode[];
    keyframes: number;
    closed: boolean;
  }[] = [];
  private videoHost: VideoHost = {
    supported: async (codecs) => codecs.filter((codec) => codec === "vp8"),
    open: async (page, _width, _height, events) => {
      const opened = { page, events, encodes: [] as VideoEncode[], keyframes: 0, closed: false };
      this.captures.push(opened);
      return {
        encodes: (specs) => {
          opened.encodes = [...specs];
        },
        keyframe: () => {
          opened.keyframes++;
        },
        close: () => {
          opened.closed = true;
        },
      };
    },
  };
  /** Holds the next `step` (such as `hide a`) until the returned function is called. */
  hold(step: string): () => void {
    const gate = Promise.withResolvers<void>();
    this.gates.set(step, gate);
    return () => gate.resolve();
  }
  /** The next `times` tries of `step` fail. */
  fail(step: string, times = 1): void {
    this.failing.set(step, (this.failing.get(step) ?? 0) + times);
  }
  /** `step` stops failing. */
  heal(step: string): void {
    this.failing.delete(step);
  }
  /** How many times each step was tried, failed tries included. */
  readonly tried = new Map<string, number>();
  /** The steps for one tab, in order. */
  steps(tabId: string): string[] {
    return this.log.filter((step) => step.endsWith(` ${tabId}`));
  }
  private async step(step: string): Promise<void> {
    const gate = this.gates.get(step);
    this.gates.delete(step);
    if (gate) await gate.promise;
    this.tried.set(step, (this.tried.get(step) ?? 0) + 1);
    const failures = this.failing.get(step) ?? 0;
    if (failures > 0) {
      this.failing.set(step, failures - 1);
      throw new Error(`${step} failed`);
    }
    this.log.push(step);
  }
  /** Each tab's current page, as the thread's last open made it (a revived tab has a new one). */
  readonly tabPages = new Map<string, BrowserBackendSession>();
  override async open(request: BackendOpen): Promise<BrowserBackendSession> {
    this.request = request;
    const hidden = new Set<string>();
    const discarded = new Set<string>();
    const addresses = new Map([
      ["a", "https://a.test/"],
      ["b", "https://b.test/"],
    ]);
    let active = "a";
    const pages = this.tabPages;
    pages.clear();
    const makePage = async (id: string) => {
      const page = await super.open(request);
      const send = page.cdp.send.bind(page.cdp);
      page.cdp.send = async (method, params) => {
        if (method === "Page.setWebLifecycleState")
          await this.step(`${params?.["state"] === "frozen" ? "freeze" : "thaw"} ${id}`);
        if (method === "Accessibility.getFullAXTree") this.log.push(`use ${id}`);
        if (method === "Page.printToPDF") {
          await this.step(`print ${id}`);
          return { data: "JVBERi0=" };
        }
        return send(method, params);
      };
      page.video = () => this.videoHost;
      page.screenshot = async () => {
        this.log.push(`picture ${id}`);
        return Buffer.from([0]);
      };
      pages.set(id, page);
      return page;
    };
    const first = await makePage("a");
    await makePage("b");
    return {
      ...first,
      tabs: {
        list: () =>
          [...pages.keys()].map((tabId) => ({
            tabId,
            url: addresses.get(tabId) ?? "about:blank",
            title: "",
            discarded: discarded.has(tabId),
          })),
        active: () => active,
        open: async () => active,
        switch: async (tabId) => {
          active = tabId;
          request.changed?.();
        },
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
          if (discarded.has(tabId) || hidden.has(tabId) === resting) return;
          await this.step(`${resting ? "hide" : "show"} ${tabId}`);
          if (resting) hidden.add(tabId);
          else hidden.delete(tabId);
        },
        resting: (tabId) => hidden.has(tabId),
        // Dropping a tab closes its page; reviving opens a new one (a new target) at its address.
        discard: async (tabId) => {
          await this.step(`discard ${tabId}`);
          discarded.add(tabId);
          hidden.delete(tabId);
        },
        revive: async (tabId) => {
          await this.step(`revive ${tabId}`);
          await makePage(tabId);
          discarded.delete(tabId);
        },
        discarded: (tabId) => discarded.has(tabId),
        proceedCertificate: (tabId) => this.step(`certificate ${tabId}`),
        chooseFiles: (tabId) => this.step(`files ${tabId}`),
        answerAuth: (tabId) => this.step(`auth ${tabId}`),
        mute: (tabId) => this.step(`mute ${tabId}`),
      },
    };
  }
}

/**
 * One thread's browser on `RestingTabs`, with the lifecycle timer and the navigation clock (which
 * paces retries) under the test's control.
 */
export async function idleThread() {
  const home = await mkdtemp(join(tmpdir(), "ace-idle-races-"));
  const clock = { now: 0 };
  const ticks: (() => void)[] = [];
  const backend = new RestingTabs();
  const navigationClock = new TestNavigationClock();
  const service = new BrowserService({
    navigationClock,
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
  return { service, backend, clock, navigationClock, ticks, idleFor, lookAfter, use, lifecycle };
}

/** Lets pending callbacks run, so a held step is reached. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A person's video viewer of the thread: the chunks it was sent, in order. */
export async function watch(service: BrowserService, connectionId = "viewer") {
  const chunks: BrowserVideoChunk[] = [];
  const assembler = new StreamAssembler();
  /** While set, the viewer's transport pushes back: chunks wait in its queue. */
  const link = { blocked: false };
  const bridge = connectBrowser(service, {
    connectionId,
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      if (link.blocked) return false;
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind === "browser.video") chunks.push(message.chunk);
      }
      return true;
    },
  });
  let closed = false;
  const leave = () => {
    if (closed) return;
    closed = true;
    bridge.close();
  };
  cleanups.push(async () => leave());
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { width: 640, height: 400, devicePixelRatio: 1 },
    video: { codecs: ["vp8"] },
  });
  const ack = (sequence: number) =>
    bridge.handle({
      type: "browser.ack",
      threadId: "thread",
      requestId: `ack-${sequence}`,
      sequence,
      video: true,
    });
  return { chunks, ack, leave, link };
}

/** The tab capture the live video opened `index`th, once it was told what to encode. */
export async function capture(backend: RestingTabs, index: number) {
  await expect
    .poll(() => backend.captures[index]?.encodes.length ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(0);
  const opened = backend.captures[index];
  const encode = opened?.encodes[0]?.key;
  if (!opened || !encode) throw new Error("No capture");
  /** One encoded picture, marked so the test can tell which it is. */
  const send = (marker: number, key: boolean) =>
    opened.events.chunk({
      encode,
      key,
      codec: "vp8",
      codedWidth: 640,
      codedHeight: 400,
      bytes: new Uint8Array([marker]),
    });
  return { opened, send };
}
