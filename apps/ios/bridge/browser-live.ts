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
import type { KeyValueStorage } from "@ace/ui-core";
import type { PatchSink, Preview } from "./agents.ts";
import { DeviceAction, devicePresetRows, PhoneDevices } from "./browser-device.ts";
import { browserViewState } from "./browser-view.ts";
import { BrowserToolAction, BrowserTools } from "./browser-tools.ts";
import { BrowserPageAction, BrowserPageTools, type PhoneFiles } from "./browser-page-tools.ts";
import { AnnotateAction, BrowserAnnotate, type ImageStager } from "./browser-annotate.ts";
import type { ThreadAnnotations } from "./thread-annotations.ts";
import { nativeChunks, type ChunkReader } from "./thread-attachments.ts";

/*
 * The thread's live browser view (ADR 0088, #1061). The bridge owns the subscription, the page's
 * state and the person's input; Swift owns the pictures. The view is video only: H.264 chunks
 * never enter JavaScriptCore, the native socket assembles and decodes them itself, and
 * acknowledges each one through `ack` as soon as it is decoded.
 */

export type BrowserOwner = Pick<
  ClientCore,
  "request" | "send" | "onMessage" | "state" | "connectionState"
> &
  Partial<Pick<ClientCore, "onStream">>;
export type Schedule = (delayMs: number, callback: () => void) => () => void;

/** The codecs the native decoder plays (VideoToolbox H.264), best first. */
export const nativeVideoCodecs = ["avc1.42E033"] as const;
/** A watched thread whose browser isn't there yet asks again this often, as the web does. */
const retryMs = 5_000;
const subscriberId = "ios-live";

const Viewport = z.object({
  width: z.number().finite(),
  height: z.number().finite(),
  devicePixelRatio: z.number().finite(),
});
/** The picture's drawn size in the view (it fits the view's width, times the person's zoom). */
const Picture = z.object({ width: z.number().finite(), height: z.number().finite() });
const BrowserAction = z.discriminatedUnion("kind", [
  /** Whether the thread has a browser now (the agent may have opened one since it was opened). */
  z.object({
    kind: z.literal("probe"),
    threadId: ThreadId,
    epoch: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("open"), threadId: ThreadId, viewport: Viewport }),
  z.object({ kind: z.literal("close") }),
  /** The view's size changed (layout, rotation): the picture is sized for it; the page keeps its device. */
  z.object({ kind: z.literal("viewport"), viewport: Viewport, picture: Picture.optional() }),
  z.object({ kind: z.literal("input"), input: z.unknown() }),
  /** Video chunks up to `sequence` are decoded (cumulative); `keyframe` after a decode error. */
  z.object({
    kind: z.literal("ack"),
    sequence: z.number().int().nonnegative(),
    keyframe: z.boolean().optional(),
  }),
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

/**
 * What the stream is encoded for: the picture as drawn (the page's width fits the view, so a page
 * taller than the view is drawn taller than it), else the view itself.
 */
function captureFor(watch: Watch): BrowserCaptureViewport {
  const picture = watch.picture;
  return picture
    ? captureViewport({ ...picture, devicePixelRatio: watch.viewport.devicePixelRatio })
    : watch.viewport;
}

/** What the view reads from the open thread, beyond the browser itself. */
export interface BrowserThreadContext {
  /** The agent's display name, for "Claude is using this page". */
  agentName(threadId: string, agentId: string | undefined): string;
  /** The thread's project, to open its browser when it has none. */
  workspaceId(threadId: string): string | undefined;
  now(): number;
  read: ChunkReader;
  /** Where the device toolbar's choices are kept on this phone, and when they have loaded. */
  devices?: { storage: KeyValueStorage; ready: Promise<void> };
  /** Where a saved download is written on the phone. */
  files?: PhoneFiles;
  /** Stages an annotation's image on the phone as a message file. */
  stage?: ImageStager;
  /** The open thread's next-message annotations. */
  annotations?(threadId: string): ThreadAnnotations | undefined;
}
const noContext: BrowserThreadContext = {
  agentName: () => "An agent",
  workspaceId: () => undefined,
  now: () => 0,
  read: nativeChunks,
};
const noFiles: PhoneFiles = {
  write: () => Promise.reject(new Error("This phone can't save files.")),
  discard: () => Promise.resolve(),
};
const noStage: ImageStager = () => Promise.reject(new Error("This phone can't stage images."));

interface Watch {
  threadId: ThreadId;
  /** The view's own size: "this phone" is laid out at it. */
  viewport: BrowserCaptureViewport;
  /** The picture's drawn size, once Swift reports it: the stream is encoded for it. */
  picture: { width: number; height: number } | undefined;
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
  #context: BrowserThreadContext;
  #tools: BrowserTools;
  #page: BrowserPageTools;
  #annotate: BrowserAnnotate;
  #devices: PhoneDevices;
  constructor(
    owner: BrowserOwner,
    sink: PatchSink,
    preview: Preview,
    schedule: Schedule,
    context: BrowserThreadContext = noContext,
  ) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#schedule = schedule;
    this.#context = context;
    this.#devices = new PhoneDevices(
      owner,
      context.devices?.storage,
      context.devices?.ready,
      () => {
        if (this.#watch) this.#putView(this.#watch);
      },
    );
    this.#tools = new BrowserTools({
      owner,
      sink,
      preview,
      schedule,
      now: () => context.now(),
      read: context.read,
      current: () => {
        const watch = this.#watch;
        return watch ? { threadId: watch.threadId, state: watch.state } : undefined;
      },
      workspaceId: (threadId) => context.workspaceId(threadId),
      changed: () => {
        if (this.#watch) this.#putView(this.#watch);
      },
      opened: () => {
        const watch = this.#watch;
        if (!watch || watch.subscribed) return;
        watch.retry?.();
        watch.retry = undefined;
        this.#subscribe(watch);
      },
    });
    const current = () => {
      const watch = this.#watch;
      return watch ? { threadId: watch.threadId, state: watch.state } : undefined;
    };
    const changed = () => {
      if (this.#watch) this.#putView(this.#watch);
    };
    this.#page = new BrowserPageTools({
      owner,
      sink,
      preview,
      now: () => context.now(),
      files: context.files ?? noFiles,
      current,
    });
    this.#annotate = new BrowserAnnotate({
      owner,
      sink,
      schedule,
      stage: context.stage ?? noStage,
      draft: (threadId) => context.annotations?.(threadId),
      current,
      now: () => context.now(),
      changed,
    });
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
        // A restarted daemon may have lost the tab's device: the next state chooses again.
        this.#devices.reset();
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
    const device = parsed.success ? undefined : DeviceAction.safeParse(raw);
    if (device?.success) {
      const watch = this.#watch;
      if (!watch) return false;
      this.#devices.handle(watch, device.data);
      this.#putView(watch);
      return true;
    }
    if (!parsed.success) {
      if (!this.#watch) return false;
      const tool = BrowserToolAction.safeParse(raw);
      if (tool.success) {
        this.#tools.handle(tool.data);
        return true;
      }
      const page = BrowserPageAction.safeParse(raw);
      if (page.success) {
        this.#page.handle(page.data);
        return true;
      }
      const annotate = AnnotateAction.safeParse(raw);
      if (!annotate.success) return false;
      this.#annotate.handle(annotate.data);
      return true;
    }
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
        picture: undefined,
        generation: 0,
        subscribed: false,
        subscribing: false,
        state: undefined,
        error: undefined,
        pages: new Map(),
        retry: undefined,
      };
      this.#watch = watch;
      this.#devices.reset();
      this.#sink.put("browser:presets", () => ({
        type: "browser.presets",
        presets: devicePresetRows,
      }));
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
        const before = watch.viewport;
        const picture = action.picture;
        const sameView =
          viewport.width === before.width &&
          viewport.height === before.height &&
          viewport.devicePixelRatio === before.devicePixelRatio;
        const samePicture =
          picture?.width === watch.picture?.width && picture?.height === watch.picture?.height;
        if (sameView && samePicture) return true;
        watch.viewport = viewport;
        watch.picture = picture;
        if (!sameView) this.#devices.resized(watch, before);
        if (watch.subscribed)
          void this.#owner
            .request({
              type: "browser.capture",
              threadId: watch.threadId,
              viewport: captureFor(watch),
            })
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
            video: true,
            ...(action.keyframe ? { keyframe: true } : {}),
          });
        } catch {
          // Offline: the subscription ended with the connection.
        }
        return true;
    }
  }
  /** Stop watching: the daemon stops this viewer's pictures. */
  close(): void {
    const watch = this.#watch;
    if (!watch) return;
    this.#watch = undefined;
    watch.retry?.();
    this.#annotate.close();
    this.#tools.close();
    this.#page.close();
    this.#sink.clear("browser:view");
    this.#sink.clear("browser:presets");
    this.#sink.clear("browser:page");
    if (this.#owner.state !== "ready") return;
    void this.#owner
      .request({ type: "browser.unsubscribe", threadId: watch.threadId, subscriberId })
      .catch(() => {});
  }
  #requestId(): string {
    return `ios-browser-${++this.#requests}`;
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
        viewport: captureFor(watch),
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
    if (message.type === "browser.annotation") {
      this.#annotate.receive(message);
      return;
    }
    if (message.type === "browser.state") {
      const state = message.state;
      if (state.threadId !== watch.threadId) return;
      const previous = watch.state;
      watch.state = state;
      this.#tools.observe(state);
      this.#page.observe(state);
      // A tab shown for the first time gets its device (`browser-device.ts`).
      this.#devices.observe(watch);
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
        // Another engine has its own pages: their devices are chosen again.
        if (previous.backend !== state.backend) this.#devices.reset();
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
    const context = this.#context;
    this.#sink.put("browser:view", () => {
      if (this.#watch !== watch) return undefined;
      const state = watch.state;
      return {
        type: "browser.view",
        threadId: watch.threadId,
        generation: watch.generation,
        error: watch.error ?? null,
        device: this.#devices.view(watch),
        state: state
          ? browserViewState(state, {
              preview: this.#preview,
              agentName: (agentId) => context.agentName(watch.threadId, agentId),
              navigation: this.#tools.navigation,
              recordingHere: this.#page.recordingHere(watch.threadId),
              annotating: this.#annotate.mode,
            })
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
