import { nativeVideoCodecs } from "./video-codecs.ts";
import type { ClientCore } from "@ace/client";
import {
  MediaSubscriptions,
  mediaSubscribeDeadlineMs,
  SubscribeRetry,
  type DeliveryState,
  type MediaRoute,
} from "@ace/browser/live-view";
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
import { nextLatency, type KeyValueStorage } from "@ace/ui-core";
import type { PatchSink, Preview } from "./agents.ts";
import { DeviceAction, devicePresetRows, PhoneDevices } from "./browser-device.ts";
import { browserViewState } from "./browser-view.ts";
import { BrowserToolAction, BrowserTools } from "./browser-tools.ts";
import { BrowserEngineTool, EngineAction } from "./browser-engine.ts";
import { BrowserWatch, WatchAction } from "./browser-watch.ts";
import { BrowserPageAction, BrowserPageTools, type PhoneFiles } from "./browser-page-tools.ts";
import { AnnotateAction, BrowserAnnotate, type ImageStager } from "./browser-annotate.ts";
import type { ThreadAnnotations } from "./thread-annotations.ts";
import { nativeChunks, type ChunkReader } from "./thread-attachments.ts";

/*
 * The thread's live browser view (ADR 0088, #1061). The bridge owns the subscription, the page's
 * state and the person's input; Swift owns the pictures. The view is video only, and only
 * ace-media delivers it (ADR 0201), on the phone's media connection: H.264 chunks never enter
 * JavaScriptCore, the native socket assembles and decodes them itself, and acknowledges each one
 * through `ack` as soon as it is decoded. The ack leaves by that media connection.
 */

export type BrowserOwner = Pick<
  ClientCore,
  "request" | "send" | "onMessage" | "state" | "connectionState"
> &
  Partial<Pick<ClientCore, "onStream">>;
export type Schedule = (delayMs: number, callback: () => void) => () => void;

/** A watched thread whose browser isn't there yet asks again this often, as the web does. */
const retryMs = 5_000;
/** Tabs sent per page; each "show more" adds as many. */
const firstTabs = 20;
const subscriberId = "ios-live";

const Viewport = z.object({
  width: z.number().finite(),
  height: z.number().finite(),
  devicePixelRatio: z.number().finite(),
});
/** The picture's drawn size in the view (it fits the view's width, times the person's zoom). */
const Picture = z.object({ width: z.number().finite(), height: z.number().finite() });
const BrowserAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tabs.more") }),
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
    fallback: z.boolean().optional(),
    /** The delivery generation the picture came for (`media.delivery`), as Swift stamped it. */
    generation: z.number().int().nonnegative().optional(),
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
  /** The thread's status state ("working", "waiting"…), for watch mode. */
  threadState?(threadId: string): string | undefined;
  /** Hears every change to the threads' statuses; call the result to stop. */
  observeThreads?(listener: () => void): () => void;
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
  /** A failed subscribe's retry on the shared ladder and cooldown. */
  ladder: SubscribeRetry;
  /**
   * A subscribe the daemon answered without delivery (ace-media can't serve it yet) asks again
   * on its own ladder, which never gives up: its source may become available at any time.
   */
  unserved: SubscribeRetry;
  subscribed: boolean;
  subscribing: boolean;
  state: BrowserState | undefined;
  error: string | undefined;
  pages: Map<string, BrowserPageState>;
  retry: (() => void) | undefined;
}

export class BrowserLive {
  #h264Only = false;
  /** Whether the view's pictures come by the media connection, and so where its acks go. */
  readonly #media = new MediaSubscriptions();
  #stopMedia: (() => void) | undefined;
  #stopDeliveries: (() => void) | undefined;
  #owner: BrowserOwner;
  #sink: PatchSink;
  #preview: Preview;
  #schedule: Schedule;
  #watch: Watch | undefined;
  #probe: { threadId: string; epoch: number } | undefined;
  #stops: (() => void)[] = [];
  #context: BrowserThreadContext;
  #tools: BrowserTools;
  #page: BrowserPageTools;
  #annotate: BrowserAnnotate;
  #engine: BrowserEngineTool;
  #following = new BrowserWatch();
  /** Each thread's input round trip in milliseconds, once the person has used its page. */
  #latency = new Map<string, number>();
  /** Stops hearing the threads' statuses; set while watch mode is on. */
  #unobserve: (() => void) | undefined;
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
        if (!watch) return;
        // A browser opened: an unserved view may be served now, and asks again (once a step).
        if (watch.subscribed && this.#media.unserved(watch.threadId) && watch.unserved.event())
          watch.subscribed = false;
        if (watch.subscribed) return;
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
    this.#engine = new BrowserEngineTool({
      owner,
      sink,
      preview,
      now: () => context.now(),
      current,
      workspaceId: (threadId) => context.workspaceId(threadId),
      changed,
      opened: () => {
        const watch = this.#watch;
        if (!watch) return;
        // A new engine streams its own pictures: Swift starts its decoder again.
        watch.subscribed = false;
        this.#restart(watch);
        this.#subscribe(watch);
      },
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
  /**
   * Take the view's pictures by this media connection while it has a binding (ADR 0147 §4):
   * whenever the binding changes, the view subscribes again and Swift starts a new decoder.
   */
  useMedia(
    route: MediaRoute | undefined,
    deliver?: (view: "browser", state: DeliveryState) => void,
  ): void {
    this.#stopMedia?.();
    this.#stopDeliveries?.();
    this.#media.use(route);
    // Swift draws and acknowledges the thread's pictures by the delivery set here.
    this.#stopDeliveries = deliver
      ? this.#media.watchDeliveries((state) => deliver("browser", state))
      : undefined;
    this.#stopMedia = route?.watch(() => {
      const watch = this.#watch;
      if (!watch || !watch.subscribed) return;
      watch.subscribed = false;
      this.#restart(watch);
      this.#subscribe(watch);
    });
  }
  dispose(): void {
    this.#stopMedia?.();
    this.#stopDeliveries?.();
    this.close();
    this.#endFollowing();
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
  #tabsLimit = firstTabs;

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
      const following = WatchAction.safeParse(raw);
      if (following.success) {
        const watch = this.#watch;
        if (!watch) return false;
        const status = this.#context.threadState?.(watch.threadId);
        const tabId = this.#following.set(watch.threadId, watch.state, following.data.on, status);
        if (tabId) this.#show(watch, tabId);
        if (this.#following.view(watch.threadId, watch.state, status)?.on) this.#observe(watch);
        else this.#endFollowing();
        this.#putView(watch);
        return true;
      }
      const engine = EngineAction.safeParse(raw);
      if (engine.success) {
        this.#engine.handle(engine.data);
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
        ladder: new SubscribeRetry(this.#media, action.threadId, (run, ms) =>
          this.#schedule(ms, run),
        ),
        unserved: new SubscribeRetry(
          { retryDelay: (source) => this.#media.unservedDelay(source), giveUp: () => {} },
          action.threadId,
          (run, ms) => this.#schedule(ms, run),
        ),
      };
      this.#watch = watch;
      // Each watch starts on the first page of tabs, whatever an earlier one had shown.
      this.#tabsLimit = firstTabs;
      this.#devices.reset();
      this.#sink.put("browser:presets", () => ({
        type: "browser.presets",
        presets: devicePresetRows,
      }));
      this.#subscribe(watch);
      const latency = this.#latency.get(action.threadId);
      if (latency !== undefined) {
        const ms = Math.round(latency);
        this.#sink.put("browser:latency", () => ({
          type: "browser.latency",
          threadId: action.threadId,
          ms,
        }));
      }
      return true;
    }
    if (action.kind === "close") {
      this.close();
      return true;
    }
    const watch = this.#watch;
    if (!watch) return false;
    switch (action.kind) {
      case "tabs.more":
        this.#tabsLimit += firstTabs;
        this.#putView(watch);
        return true;
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
        const started = this.#context.now();
        void this.#owner
          .request({
            type: "browser.input",
            threadId: watch.threadId,
            input: input.data,
            ...(tabId ? { tabId } : {}),
          })
          .then(() => this.#timed(watch.threadId, this.#context.now() - started))
          .catch(() => {});
        return true;
      }
      case "ack": {
        const ack = {
          type: "browser.ack" as const,
          threadId: watch.threadId,
          sequence: action.sequence,
          video: true as const,
          ...(action.keyframe ? { keyframe: true as const } : {}),
        };
        // Each ack goes by the media connection its picture's delivery came on (Swift stamps the
        // generation it was delivered for), or nowhere once it is stale: a picture of an earlier
        // subscribe (another thread's, or this one's before it subscribed again) says nothing
        // about this view now, neither its ack nor its decoder's failure.
        if (this.#media.way(watch.threadId, action.generation) !== "media") return true;
        this.#media.route?.ack(ack);
        if (action.fallback && !this.#h264Only) {
          this.#h264Only = true;
          watch.subscribed = false;
          this.#restart(watch);
          this.#subscribe(watch);
        }
        return true;
      }
    }
  }
  /** Stop watching: the daemon stops this viewer's pictures. */
  close(): void {
    const watch = this.#watch;
    if (!watch) return;
    this.#watch = undefined;
    watch.retry?.();
    watch.ladder.stop();
    watch.unserved.stop();
    this.#media.forget(watch.threadId);
    this.#endFollowing();
    this.#annotate.close();
    this.#tools.close();
    this.#page.close();
    this.#sink.clear("browser:view");
    this.#sink.clear("browser:latency");
    this.#sink.clear("browser:presets");
    this.#sink.clear("browser:page");
    if (this.#owner.state !== "ready") return;
    void this.#owner
      .request({ type: "browser.unsubscribe", threadId: watch.threadId, subscriberId })
      .catch(() => {});
  }
  /**
   * Subscribes the view, unless it is subscribed or one is on its way. After a failed subscribe it
   * waits on the shared ladder and cooldown (`SubscribeRetry`): the view's own poll waits with
   * it, and an event (an engine opened, the state changed, a new session) may skip one step's
   * wait, never the cooldown.
   */
  #subscribe(watch: Watch, cause: "event" | "poll" = "event"): void {
    if (this.#watch !== watch || watch.subscribed || watch.subscribing) return;
    if (watch.ladder.waiting && (cause === "poll" || !watch.ladder.event())) return;
    // An unserved view waits on its own ladder; an event may cut one step of it short.
    if (watch.unserved.waiting && (cause === "poll" || !watch.unserved.event())) return;
    watch.retry?.();
    watch.retry = this.#schedule(retryMs, () => {
      watch.retry = undefined;
      this.#subscribe(watch, "poll");
    });
    if (this.#owner.state !== "ready") return;
    watch.subscribing = true;
    const generation = watch.generation;
    const h264Only = this.#h264Only;
    const binding = this.#media.route?.binding()?.connection;
    const begun = this.#media.begin(watch.threadId);
    // The browser names its decoders in `video`; the rest says this client takes pictures only
    // from its media connection and reads `browser.delivery`.
    const { media, mediaClient, deliveryStatus } = begun.fields;
    let refused = false;
    /** The request failed while it was still the view's latest, however its delivery settled. */
    let lost = false;
    const failed = (error: unknown) => {
      const next = this.#media.failed(watch.threadId, begun.generation, error);
      if (next === "resubscribe") refused = true;
      // To be tried again (its delivery settled on the channel, or the one it replaced restored,
      // whose generation is then the source's again): it climbs the ladder.
      else if (next === "retry") lost = true;
      // `ignore` after the deadline settled its delivery, while it is still the latest: the
      // request failed all the same. One a later subscribe superseded leaves that one to it.
      else if (this.#media.generation(watch.threadId) === begun.generation) lost = true;
    };
    // No answer in time: the thread stops waiting on the media connection (a late reply still
    // settles it), so Swift stops holding its pictures.
    const deadline = media
      ? this.#schedule(mediaSubscribeDeadlineMs, () =>
          this.#media.abandon(watch.threadId, begun.generation),
        )
      : undefined;
    void this.#owner
      .request({
        type: "browser.subscribe",
        threadId: watch.threadId,
        subscriberId,
        binaryFrames: true,
        viewport: captureFor(watch),
        video: { codecs: this.#h264Only ? ["avc1.42E033"] : nativeVideoCodecs() },
        ...(media ? { media } : {}),
        mediaClient,
        deliveryStatus,
      })
      .then(
        (reply) => {
          if (this.#watch !== watch) return;
          if (!reply.ok) {
            // A connection the daemon won't bind for this view is named no more; any other failure
            // falls back as the shared client says, and is asked again on its ladder.
            failed(new Error(reply.error ?? ""));
            if (refused) return;
            watch.error = reply.error ?? "browser_failed";
            this.#putView(watch);
            return;
          }
          watch.error = undefined;
          watch.subscribed = true;
          // Delivery by the media connection only when the daemon's answer says so; otherwise
          // none, and why.
          this.#media.subscribed(watch.threadId, begun.generation, reply.media, reply.undelivered);
          // The menu's note names the machine's default; read again on each new subscription.
          void this.#engine.readDefault();
          watch.retry?.();
          watch.retry = undefined;
          // Answered without delivery: asked again on the unserved ladder, never giving up.
          if (this.#media.unserved(watch.threadId))
            watch.unserved.failed(() => {
              if (this.#watch !== watch) return;
              watch.subscribed = false;
              this.#subscribe(watch, "poll");
            });
          else watch.unserved.stop();
          // A size reported while the subscribe was on its way.
          if (generation === watch.generation) this.#putView(watch);
        },
        // Lost on its way (offline, timed out): settled or restored as the shared client says.
        (error: unknown) => {
          if (this.#watch === watch) failed(error);
        },
      )
      .finally(() => {
        deadline?.();
        watch.subscribing = false;
        // The binding moved while this subscribe was on its way, or the daemon refused it.
        const moved = binding !== this.#media.route?.binding()?.connection;
        if (h264Only !== this.#h264Only || ((moved || refused) && this.#watch === watch)) {
          watch.subscribed = false;
          this.#subscribe(watch);
        } else if (this.#watch === watch && lost) {
          // Asked again on the shared ladder; the view's own poll waits with it.
          watch.retry?.();
          watch.retry = undefined;
          watch.ladder.failed(() => this.#subscribe(watch, "poll"));
        } else if (this.#watch === watch && !watch.subscribed && !watch.retry) {
          // Not subscribed and nothing else on its way (the view's own poll may have fired while
          // this one was out): it asks again at its usual pace.
          watch.retry = this.#schedule(retryMs, () => {
            watch.retry = undefined;
            this.#subscribe(watch, "poll");
          });
        }
      });
  }
  /** The daemon starts this viewer's pictures again (a new tab, backend or connection). */
  /**
   * The person's input round trip, sent to answered, for the ⋯ menu's connection stats: a
   * moving average per thread, sent only when its whole milliseconds change.
   */
  #timed(threadId: string, sample: number): void {
    const before = this.#latency.get(threadId);
    const next = nextLatency(before, sample);
    this.#latency.set(threadId, next);
    const ms = Math.round(next);
    if (before !== undefined && Math.round(before) === ms) return;
    this.#sink.put("browser:latency", () => ({ type: "browser.latency", threadId, ms }));
  }
  /** Watch mode hears the thread's status, to end once its agents stop working. */
  #observe(watch: Watch): void {
    if (this.#unobserve) return;
    this.#unobserve = this.#context.observeThreads?.(() => {
      const status = this.#context.threadState?.(watch.threadId);
      if (this.#watch !== watch || !this.#following.status(watch.threadId, status)) return;
      this.#endFollowing();
      this.#putView(watch);
    });
  }
  #endFollowing(): void {
    this.#following.stop();
    this.#unobserve?.();
    this.#unobserve = undefined;
  }
  /** Watch mode shows the agent's tab. */
  #show(watch: Watch, tabId: string): void {
    void this.#owner
      .request({ type: "browser.tabs.select", threadId: watch.threadId, tabId })
      .catch(() => {});
  }
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
    if (message.type === "browser.delivery") {
      // Whether the bound view gets pictures now, and why not: Swift says it until one comes.
      if (message.threadId === watch.threadId)
        this.#media.report(message.threadId, message.undelivered);
      return;
    }
    if (message.type === "browser.state") {
      const state = message.state;
      if (state.threadId !== watch.threadId) return;
      const previous = watch.state;
      watch.state = state;
      this.#tools.observe(state);
      this.#page.observe(state);
      const follow = this.#following.follow(watch.threadId, state);
      if (follow) this.#show(watch, follow);
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
        engine: state ? this.#engine.view(state, watch.threadId) : null,
        watch: this.#following.view(
          watch.threadId,
          state,
          this.#context.threadState?.(watch.threadId),
        ),
        state: state
          ? browserViewState(state, {
              tabsLimit: this.#tabsLimit,
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
