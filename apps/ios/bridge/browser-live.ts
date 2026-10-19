import type { ClientCore } from "@ace/client";
import {
  BrowserCaptureViewport,
  BrowserInput,
  BrowserTabList,
  ThreadId,
  type BrowserPageState,
  type BrowserState,
  type ServerMessage,
} from "@ace/protocol";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";

/*
 * The thread's live browser view (ADR 0088, #1061). The bridge owns the subscription, the page's
 * state and the person's input; Swift owns the pictures. Binary stream messages (JPEG frames
 * and H.264 chunks) never enter JavaScriptCore: the native socket assembles and decodes them
 * itself, and acknowledges each one through `ack` once it is on screen.
 */

export type BrowserOwner = Pick<
  ClientCore,
  "request" | "send" | "onMessage" | "state" | "connectionState"
>;
export type Schedule = (delayMs: number, callback: () => void) => () => void;

/** The codecs the native decoder plays (VideoToolbox H.264), best first. */
export const nativeVideoCodecs = ["avc1.42E033"] as const;
/** A watched thread whose browser isn't there yet asks again this often, as the web does. */
const retryMs = 5_000;
/** Tabs listed in the view's tab menu; the rest are counted. */
const tabLimit = 20;
const subscriberId = "ios-live";

const Viewport = z.object({
  width: z.number().finite(),
  height: z.number().finite(),
  devicePixelRatio: z.number().finite(),
});
const BrowserAction = z.discriminatedUnion("kind", [
  /** Whether the thread has a browser now (the agent may have opened one since it was opened). */
  z.object({
    kind: z.literal("probe"),
    threadId: ThreadId,
    epoch: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("open"), threadId: ThreadId, viewport: Viewport }),
  z.object({ kind: z.literal("close") }),
  /** The view's size changed (layout, rotation): the page takes it, as a touch screen. */
  z.object({ kind: z.literal("viewport"), viewport: Viewport }),
  z.object({ kind: z.literal("input"), input: z.unknown() }),
  /** A picture is on screen: JPEG frames one at a time, video chunks cumulatively. */
  z.object({
    kind: z.literal("ack"),
    sequence: z.number().int().nonnegative(),
    video: z.boolean().optional(),
    keyframe: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("history"),
    direction: z.enum(["back", "forward", "reload", "stop"]),
  }),
  z.object({ kind: z.literal("tab"), tabId: z.string().min(1).max(256) }),
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

const clampSide = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));
/** The view's size as `browser.capture` takes it: CSS pixels and the screen's scale. */
export function captureViewport(viewport: z.infer<typeof Viewport>): BrowserCaptureViewport {
  return BrowserCaptureViewport.parse({
    width: clampSide(viewport.width),
    height: clampSide(viewport.height),
    devicePixelRatio: Math.min(4, Math.max(1, viewport.devicePixelRatio)),
  });
}

interface Watch {
  threadId: ThreadId;
  viewport: BrowserCaptureViewport;
  /** Bumped whenever the daemon starts this viewer's pictures again; Swift resets its decoder. */
  generation: number;
  subscribed: boolean;
  subscribing: boolean;
  state: BrowserState | undefined;
  error: string | undefined;
  pages: Map<string, BrowserPageState>;
  retry: (() => void) | undefined;
}

export class BrowserLive {
  #owner: BrowserOwner;
  #sink: PatchSink;
  #preview: Preview;
  #schedule: Schedule;
  #watch: Watch | undefined;
  #probe: { threadId: string; epoch: number } | undefined;
  #requests = 0;
  #stops: (() => void)[] = [];
  constructor(owner: BrowserOwner, sink: PatchSink, preview: Preview, schedule: Schedule) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#schedule = schedule;
    this.#stops.push(owner.onMessage((message) => this.#receive(message)));
    const connection = owner.connectionState();
    this.#stops.push(
      connection.subscribe(() => {
        const ready = connection.getSnapshot() === "ready";
        const probe = this.#probe;
        if (ready && probe) {
          this.#probe = undefined;
          this.probe(probe.threadId, probe.epoch);
        }
        const watch = this.#watch;
        if (!watch) return;
        // The daemon dropped this connection's subscriptions; a ready one subscribes again.
        watch.subscribed = false;
        this.#restart(watch);
        if (!ready) return;
        this.#resize(watch);
        this.#subscribe(watch);
      }),
    );
  }
  dispose(): void {
    this.close();
    for (const stop of this.#stops.splice(0)) stop();
  }
  /**
   * Whether the thread has a browser with a tab open, for the thread's Browser entry. A read the
   * daemon refuses (no browser, view-only without the thread) reads as none.
   */
  probe(threadId: string, epoch: number): void {
    const id = ThreadId.safeParse(threadId);
    if (!id.success) return;
    // Asked again once the connection is ready (a thread opened at launch or offline).
    if (this.#owner.state !== "ready") {
      this.#probe = { threadId, epoch };
      return;
    }
    this.#probe = undefined;
    const put = (live: boolean) =>
      this.#sink.put("browser:available", () => ({
        type: "browser.available",
        threadId,
        epoch,
        live,
      }));
    void this.#owner
      .request({ type: "browser.tabs.list", threadId: id.data })
      .then((reply) => {
        const tabs = reply.ok ? BrowserTabList.safeParse(reply.result) : undefined;
        put(tabs?.success === true && tabs.data.length > 0);
      })
      .catch(() => put(false));
  }
  /** False when the action can't be read or needs an open view that isn't there. */
  action(raw: unknown): boolean {
    const parsed = BrowserAction.safeParse(raw);
    if (!parsed.success) return false;
    const action = parsed.data;
    if (action.kind === "probe") {
      this.probe(action.threadId, action.epoch);
      return true;
    }
    if (action.kind === "open") {
      this.close();
      const watch: Watch = {
        threadId: action.threadId,
        viewport: captureViewport(action.viewport),
        generation: 0,
        subscribed: false,
        subscribing: false,
        state: undefined,
        error: undefined,
        pages: new Map(),
        retry: undefined,
      };
      this.#watch = watch;
      this.#resize(watch);
      this.#subscribe(watch);
      return true;
    }
    if (action.kind === "close") {
      this.close();
      return true;
    }
    const watch = this.#watch;
    if (!watch) return false;
    switch (action.kind) {
      case "viewport": {
        const viewport = captureViewport(action.viewport);
        if (
          viewport.width === watch.viewport.width &&
          viewport.height === watch.viewport.height &&
          viewport.devicePixelRatio === watch.viewport.devicePixelRatio
        )
          return true;
        watch.viewport = viewport;
        this.#resize(watch);
        if (watch.subscribed)
          void this.#owner
            .request({ type: "browser.capture", threadId: watch.threadId, viewport })
            .catch(() => {});
        return true;
      }
      case "input": {
        const input = BrowserInput.safeParse(action.input);
        if (!input.success) return false;
        const tabId = watch.state?.activeTabId;
        void this.#owner
          .request({
            type: "browser.input",
            threadId: watch.threadId,
            input: input.data,
            ...(tabId ? { tabId } : {}),
          })
          .catch(() => {});
        return true;
      }
      case "ack":
        try {
          this.#owner.send({
            type: "browser.ack",
            requestId: this.#requestId(),
            threadId: watch.threadId,
            sequence: action.sequence,
            ...(action.video ? { video: true } : {}),
            ...(action.keyframe ? { keyframe: true } : {}),
          });
        } catch {
          // Offline: the subscription ended with the connection.
        }
        return true;
      case "history": {
        const tabId = watch.state?.activeTabId;
        void this.#owner
          .request({
            type: "browser.execute",
            threadId: watch.threadId,
            command: {
              action: "history",
              direction: action.direction,
              ...(tabId ? { tabId } : {}),
            },
          })
          .catch(() => {});
        return true;
      }
      case "tab":
        void this.#owner
          .request({ type: "browser.tabs.select", threadId: watch.threadId, tabId: action.tabId })
          .catch(() => {});
        return true;
    }
  }
  /** Stop watching: the daemon stops this viewer's pictures. */
  close(): void {
    const watch = this.#watch;
    if (!watch) return;
    this.#watch = undefined;
    watch.retry?.();
    this.#sink.clear("browser:view");
    this.#sink.clear("browser:page");
    if (this.#owner.state !== "ready") return;
    void this.#owner
      .request({ type: "browser.unsubscribe", threadId: watch.threadId, subscriberId })
      .catch(() => {});
  }
  #requestId(): string {
    return `ios-browser-${++this.#requests}`;
  }
  /** The page lays out at the view's size, as a phone's page with touch events. */
  #resize(watch: Watch): void {
    if (this.#owner.state !== "ready") return;
    void this.#owner
      .request({
        type: "browser.execute",
        threadId: watch.threadId,
        command: {
          action: "resize",
          width: watch.viewport.width,
          height: watch.viewport.height,
          touch: true,
          devicePixelRatio: watch.viewport.devicePixelRatio,
        },
      })
      .catch(() => {});
  }
  #subscribe(watch: Watch): void {
    if (this.#watch !== watch || watch.subscribed || watch.subscribing) return;
    watch.retry?.();
    watch.retry = this.#schedule(retryMs, () => {
      watch.retry = undefined;
      this.#subscribe(watch);
    });
    if (this.#owner.state !== "ready") return;
    watch.subscribing = true;
    const generation = watch.generation;
    void this.#owner
      .request({
        type: "browser.subscribe",
        threadId: watch.threadId,
        subscriberId,
        binaryFrames: true,
        viewport: watch.viewport,
        video: { codecs: [...nativeVideoCodecs] },
      })
      .then(
        (reply) => {
          if (this.#watch !== watch) return;
          if (!reply.ok) {
            watch.error = reply.error ?? "browser_failed";
            this.#putView(watch);
            return;
          }
          watch.error = undefined;
          watch.subscribed = true;
          watch.retry?.();
          watch.retry = undefined;
          // A size reported while the subscribe was on its way.
          if (generation === watch.generation) this.#putView(watch);
        },
        () => {},
      )
      .finally(() => {
        watch.subscribing = false;
      });
  }
  /** The daemon starts this viewer's pictures again (a new tab, backend or connection). */
  #restart(watch: Watch): void {
    watch.generation++;
    watch.pages.clear();
    this.#sink.clear("browser:page");
    this.#putView(watch);
  }
  #receive(message: ServerMessage): void {
    const watch = this.#watch;
    if (!watch) return;
    if (message.type === "browser.state") {
      const state = message.state;
      if (state.threadId !== watch.threadId) return;
      const previous = watch.state;
      watch.state = state;
      if (
        previous &&
        ((state.closed && !previous.closed) ||
          ((state.status === "paused" || state.status === "recovering") &&
            previous.status !== state.status) ||
          previous.backend !== state.backend ||
          previous.activeTabId !== state.activeTabId)
      ) {
        watch.subscribed = false;
        this.#restart(watch);
        if (!state.closed) this.#subscribe(watch);
      } else this.#putView(watch);
      if (state.tabs) {
        const open = new Set(state.tabs.map((tab) => tab.tabId));
        for (const tabId of watch.pages.keys()) if (!open.has(tabId)) watch.pages.delete(tabId);
      }
      this.#putPage(watch);
      return;
    }
    if (message.type === "browser.page") {
      if (message.threadId !== watch.threadId) return;
      watch.pages.set(message.tabId, message.page);
      this.#putPage(watch);
    }
  }
  #putView(watch: Watch): void {
    const preview = this.#preview;
    this.#sink.put("browser:view", () => {
      if (this.#watch !== watch) return undefined;
      const state = watch.state;
      const tabs = state?.tabs ?? [];
      return {
        type: "browser.view",
        threadId: watch.threadId,
        generation: watch.generation,
        error: watch.error ?? null,
        state: state
          ? {
              url: preview(state.url, 2048),
              closed: state.closed,
              status: state.status ?? "ready",
              reason: state.reason ? preview(state.reason, 512) : null,
              loading: state.loading === true,
              loadError: state.loadError ? preview(state.loadError, 512) : null,
              activeTabId: state.activeTabId ?? null,
              tabs: tabs.slice(0, tabLimit).map((tab) => ({
                id: tab.tabId,
                title: preview(tab.title || tab.label || tab.url, 120),
                url: preview(tab.url, 512),
              })),
              moreTabs: Math.max(0, tabs.length - tabLimit),
            }
          : null,
      };
    });
  }
  /** Only the shown tab's page state goes to Swift. */
  #putPage(watch: Watch): void {
    const tabId = watch.state?.activeTabId;
    const preview = this.#preview;
    this.#sink.put("browser:page", () => {
      if (this.#watch !== watch) return undefined;
      const page = tabId ? watch.pages.get(tabId) : undefined;
      return {
        type: "browser.page",
        threadId: watch.threadId,
        tabId: tabId ?? null,
        page: page ? pagePatch(page, preview) : null,
      };
    });
  }
}

/** The page state Swift draws: labels shortened for display, values kept exact. */
function pagePatch(page: BrowserPageState, preview: Preview) {
  return {
    focus: page.focus ?? null,
    picker: page.picker
      ? {
          ...page.picker,
          options: page.picker.options?.map((option) => ({
            ...option,
            label: preview(option.label, 256),
            ...(option.group ? { group: preview(option.group, 128) } : {}),
          })),
        }
      : null,
    cursor: page.cursor ?? null,
    tooltip: page.tooltip ? { ...page.tooltip, text: preview(page.tooltip.text, 512) } : null,
  };
}
