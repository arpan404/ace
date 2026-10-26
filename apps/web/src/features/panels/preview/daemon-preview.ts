import { z } from "zod";
import type { ClientApi } from "@ace/client";
import {
  BrowserScreenshotSet,
  BrowserState,
  BrowserTabList,
  BrowserTabsResult,
  ThreadId,
  WorkspaceId,
  type BrowserInput,
  type BrowserCaptureViewport,
  type ServerMessage,
} from "@ace/protocol";
import type {
  BrowserDownload,
  BrowserExtensionView,
  BrowserTabView,
  BrowserView,
  ForwardedInput,
  PreviewLink,
  PreviewServer,
  PreviewSource,
} from "../sources.ts";
import { schedule as defaultSchedule, type Schedule } from "../schedule.ts";
import { documentVisibility, type PageVisibility } from "@/lib/page-visibility.ts";
import { daemonAnnotate } from "./daemon-annotate.ts";
import { LivePicture } from "./live-picture.ts";
import { SuggestionStore } from "./preview-suggestions.ts";
import { readBrowserLogs } from "@ace/ui-core";
import { PageStates } from "./page-states.ts";
import { ThreadVideos } from "./thread-videos.ts";
import { ThreadAudio } from "./thread-audio.ts";
import {
  webAudioOutput,
  webCodecsAudioDecoder,
  type AudioDecoderFactory,
  type AudioOutputFactory,
} from "./audio-codecs.ts";
import {
  webCodecsDecoder,
  webCodecsSupport,
  type VideoDecoderFactory,
  type VideoSupport,
} from "@/lib/video/codecs.ts";

/** How often a watched thread without a browser asks again, and re-reads its dev servers. */
const retryMs = 5_000;
/** The daemon gives up on a Chromium download after 10 minutes; wait a little longer. */
const openTimeoutMs = 660_000;
/** Threads no view shows whose last browser state and picture are kept, so coming back is instant. */
const keptThreads = 8;
/** Tabs per thread whose last picture is kept for split view. */
const stillsPerThread = 4;
/** BrowserCommand `resize` bounds. */
const clamp = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));

const tabView = (tab: BrowserTabList[number]): BrowserTabView => ({
  tabId: tab.tabId,
  url: tab.url,
  title: tab.title,
  favicon: tab.favicon,
  loading: tab.loading,
  label: tab.label,
  openedBy: tab.openedBy,
  inUse: tab.inUse,
  pointer: tab.pointer,
  private: tab.private,
  pendingDialog: tab.pending_dialog,
  pendingAuth: tab.pending_auth,
  fileChooser: tab.file_chooser,
  audible: tab.audible,
  muted: tab.muted,
  certificateError: tab.certificate_error,
  playing: tab.playing,
  canGoBack: tab.canGoBack,
  canGoForward: tab.canGoForward,
  zoom: tab.zoom,
  emulation: tab.emulation,
});

const view = (state: BrowserState): BrowserView => ({
  threadId: state.threadId,
  url: state.url,
  closed: state.closed,
  status: state.status,
  reason: state.reason,
  backend: state.backend,
  pageStateLost: state.pageStateLost,
  tabs: state.tabs?.map(tabView),
  activeTabId: state.activeTabId,
  loading: state.loading,
  loadError: state.loadError,
  permissionDenied: state.permissionDenied,
  downloads: state.downloads,
  pendingDialog: state.pending_dialog,
  annotation: state.annotation,
  features: state.features,
  recording: state.recording,
});

const wireInput = (input: ForwardedInput): BrowserInput => {
  if (input.kind === "mouse")
    return {
      ...input,
      button: input.button ?? "left",
      clickCount: input.clickCount ?? 1,
      modifiers: input.modifiers ?? 0,
    };
  if (input.kind === "scroll") return { ...input, modifiers: input.modifiers ?? 0 };
  if (input.kind === "touch" || input.kind === "ime") return input;
  if (input.kind === "pick")
    return {
      kind: "pick",
      pickerId: input.pickerId,
      ...(input.values ? { values: [...input.values] } : {}),
    };
  return {
    kind: "key",
    event: input.event,
    key: input.key,
    ...(input.code ? { code: input.code } : {}),
    modifiers: input.modifiers ?? 0,
    ...(input.text ? { text: input.text } : {}),
  };
};

const Extensions = z.object({
  extensions: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        version: z.string().optional(),
        enabled: z.boolean(),
      }),
    )
    .max(256),
});

/** The address a navigation reached, from its `browser.result` (the page's state). */
function reached(result: unknown, fallback: string): string {
  return typeof result === "object" &&
    result !== null &&
    "url" in result &&
    typeof result.url === "string"
    ? result.url
    : fallback;
}

interface Watch {
  generation: number;
  count: number;
  subscribed: boolean;
  subscribing: boolean;
  /** Cancels the next poll. */
  cancel: (() => void) | undefined;
}

export interface PreviewOptions {
  schedule?: Schedule;
  visibility?: PageVisibility;
  /** This screen's device pixel ratio, for a viewer that hasn't reported its pane yet. */
  devicePixelRatio?: () => number;
  /**
   * The video decoder (ADR 0088); omitted: the platform's WebCodecs `VideoDecoder`, if any.
   * `null`: none, so live pages can't show here.
   */
  videoDecoder?: VideoDecoderFactory | null;
  /** Which codecs the decoder plays; omitted: asks WebCodecs. */
  videoSupport?: VideoSupport;
  /**
   * The page sound's decoder and speaker (ADR 0088, Audio); omitted: WebCodecs `AudioDecoder`
   * and Web Audio, if any. `null`: offer no sound.
   */
  audioDecoder?: AudioDecoderFactory | null;
  audioOutput?: AudioOutputFactory | null;
  /** Local time in ms on the speaker's clock; omitted: `performance.now()`. */
  clock?: () => number;
}

/**
 * The thread's browser through the daemon's browser relay (ADR 0055) and its dev servers through
 * the preview gateway. The page shows only as video (ADR 0088): each chunk is ACKed (cumulatively)
 * as soon as it decodes, and the newest picture is drawn on the next animation frame; while the
 * page is hidden nothing is ACKed or polled, so the stream pauses until it is shown. People and
 * agents share every tab: nothing is taken or handed back, and the person's commands name the
 * tab they act in.
 */
export function daemonPreview(client: ClientApi, options: PreviewOptions = {}): PreviewSource {
  const lifetime = new AbortController();
  const request: ClientApi["request"] = (payload, requestOptions) =>
    client.request(payload, { ...requestOptions, signal: lifetime.signal });
  const later = options.schedule ?? defaultSchedule;
  const visibility = options.visibility ?? documentVisibility;
  const screenRatio = options.devicePixelRatio ?? (() => globalThis.devicePixelRatio || 1);
  /**
   * What each thread's view shows (`browser.capture`), kept apart from the watch: a pane can
   * report its size before it watches, and the report goes with the subscribe so the daemon
   * sizes even the first frame for it.
   */
  const captures = new Map<string, BrowserCaptureViewport>();
  const captureOf = (threadId: string): BrowserCaptureViewport =>
    captures.get(threadId) ?? {
      width: 1280,
      height: 720,
      devicePixelRatio: Math.min(4, Math.max(1, screenRatio())),
    };
  /** Video needs a client that hands over binary stream messages. */
  const binaryFrames = typeof client.onStream === "function";
  const listeners = new Map<() => void, string | undefined>();
  const views = new Map<string, BrowserView>();
  /** A pane size waiting for the tab's current state (`fitPane`). */
  const panes = new Map<string, () => void>();
  /** Threads whose state arrived since their stream last started over: it is the current one. */
  const current = new Set<string>();
  /** Sends a waiting pane size, unless the shown tab has a device by now. */
  const releasePane = (threadId: string) => {
    const send = panes.get(threadId);
    if (!send || !current.has(threadId) || !watches.get(threadId)?.subscribed) return;
    if (client.state !== "ready") return;
    panes.delete(threadId);
    const view = views.get(threadId);
    const shown = view?.tabs?.find((tab) => tab.tabId === view.activeTabId);
    if (!shown?.emulation) send();
  };
  const frames = new Map<string, LivePicture>();
  /** Each thread's tabs' last pictures from when they were shown (split view's other half). */
  const stills = new Map<string, Map<string, LivePicture>>();
  /** The shown tab changed: its picture stays as that tab's still instead of being dropped. */
  const keepStill = (threadId: string, tabId: string) => {
    const frame = frames.get(threadId);
    if (!frame) return;
    frames.delete(threadId);
    const kept = stills.get(threadId) ?? new Map<string, LivePicture>();
    kept.get(tabId)?.release();
    kept.delete(tabId);
    kept.set(tabId, frame);
    for (const [oldest, still] of kept) {
      if (kept.size <= stillsPerThread) break;
      still.release();
      kept.delete(oldest);
    }
    stills.set(threadId, kept);
  };
  const servers = new Map<string, readonly PreviewServer[]>();
  /** Each tab's page state: focused field, picker, cursor shape, tooltip. */
  const pages = new PageStates();
  const suggestions = new SuggestionStore();
  const watches = new Map<string, Watch>();
  /** A thread's pictures are seen now: the page shows and no native view covers it. */
  const seen = (threadId: string) =>
    visibility.visible() && captures.get(threadId)?.nativeShown !== true;
  const videoDecoder = binaryFrames
    ? options.videoDecoder === null
      ? undefined
      : (options.videoDecoder ?? webCodecsDecoder())
    : undefined;
  const clock = options.clock ?? (() => performance.now());
  /** Each thread's page sound: only with video, and muted until the person unmutes it. */
  const sounds = new ThreadAudio({
    decoder:
      videoDecoder && options.audioDecoder !== null
        ? (options.audioDecoder ?? webCodecsAudioDecoder())
        : undefined,
    output:
      options.audioOutput === null ? undefined : (options.audioOutput ?? webAudioOutput(clock)),
    now: clock,
  });
  /** Each thread's video, when this client decodes it (binary stream messages only). */
  const videos = new ThreadVideos({
    decoder: videoDecoder,
    support: options.videoSupport ?? webCodecsSupport,
    schedule: later,
    seen,
    watching: (threadId) => watches.has(threadId),
    present: (threadId, video) => {
      if (!watches.has(threadId)) return video.picture.close();
      sounds.shown(threadId, video.timestamp);
      const current = frames.get(threadId);
      // Same sizes: swapped in place, and the canvases draw it on their next animation frame
      // without a render. Other sizes lay the view out again.
      if (current?.fits(video)) return current.replace(video.picture);
      current?.release();
      frames.set(threadId, new LivePicture(video, video.picture));
      changed(threadId);
    },
    ack: (threadId, sequence, keyframe) => ack(threadId, sequence, keyframe),
  });
  /** Threads no view shows any more, oldest first; their state goes past `keptThreads`. */
  const unwatched = new Set<string>();
  let disposed = false;
  const stops: (() => void)[] = [];
  let version = 0;
  let requests = 0;
  let download: BrowserDownload | undefined;
  let gateway = true;
  /** A change to one thread (or, without one, to every thread: the download, the gateway). */
  const changed = (threadId?: string) => {
    if (disposed) return;
    version++;
    for (const [listener, scope] of listeners)
      if (scope === undefined || threadId === undefined || scope === threadId) listener();
  };
  // Whether this client decodes video at all decides what a view shows before any picture.
  void videos.codecs().then(() => changed());
  const release = (threadId: string) => {
    frames.get(threadId)?.release();
    frames.delete(threadId);
    for (const still of stills.get(threadId)?.values() ?? []) still.release();
    stills.delete(threadId);
    views.delete(threadId);
    pages.delete(threadId);
    servers.delete(threadId);
    suggestions.delete(threadId);
    captures.delete(threadId);
    videos.delete(threadId);
    sounds.delete(threadId);
  };
  /**
   * The thread's stream starts over (a reconnect, a pause, another backend). Its last picture
   * stays until the new stream's first keyframe replaces it.
   */
  const invalidate = (threadId: string, watch: Watch) => {
    watch.generation++;
    videos.reset(threadId);
    sounds.reset(threadId);
    // The next subscription sends every tab's page state again.
    pages.delete(threadId);
    current.delete(threadId);
  };
  /** The page is gone (the browser closed): so is its picture. */
  const dropPicture = (threadId: string) => {
    frames.get(threadId)?.release();
    frames.delete(threadId);
  };
  const requestId = () => `browser-${++requests}`;
  const call = async (
    type: "browser.unsubscribe" | "browser.close" | "browser.recording.stop",
    threadId: string,
  ) => {
    if (disposed) throw new Error("preview_disposed");
    const reply = await request({ type, threadId: ThreadId.parse(threadId) });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  /**
   * Subscribes for the thread's state and video with the codecs this client decodes and, when
   * known, what it shows. A client that decodes none still subscribes, for the tabs and the
   * page's state; it shows no picture.
   */
  const subscribe = async (threadId: string) => {
    if (disposed) throw new Error("preview_disposed");
    const codecs = await videos.codecs();
    if (disposed) throw new Error("preview_disposed");
    const viewport = captures.get(threadId);
    const reply = await request({
      type: "browser.subscribe",
      threadId: ThreadId.parse(threadId),
      ...(binaryFrames ? { binaryFrames: true } : {}),
      ...(viewport ? { viewport } : {}),
      ...(codecs.length ? { video: { codecs: [...codecs] } } : {}),
    });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  /** A person's browser command, in the tab it names (else the one shown). */
  const execute = async (
    threadId: string,
    command: Extract<Parameters<ClientApi["request"]>[0], { type: "browser.execute" }>["command"],
    timeoutMs?: number,
  ) => {
    const reply = await request(
      { type: "browser.execute", threadId: ThreadId.parse(threadId), command },
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  const tabs = async (
    message:
      | { type: "browser.tabs.open"; url?: string }
      | { type: "browser.tabs.select" | "browser.tabs.close"; tabId: string },
    threadId: string,
  ) => {
    const reply = await request({ ...message, threadId: ThreadId.parse(threadId) });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  const annotate = daemonAnnotate(client, request);
  stops.push(annotate.dispose);
  const previews = async (
    threadId: string,
    operation: { op: "list"; suggestions: true } | { op: "forward" | "unforward"; port: number },
  ) => {
    const reply = await request({
      type: "preview.request",
      threadId: ThreadId.parse(threadId),
      operation,
    });
    if (disposed) return;
    const available = reply.ok || reply.error !== "preview_unavailable";
    if (available !== gateway) {
      gateway = available;
      changed();
    }
    const kept = watches.has(threadId) || unwatched.has(threadId);
    // Detection doesn't need the gateway, so a refusal can still carry the thread's servers.
    if (kept && reply.suggestions && suggestions.set(threadId, reply.suggestions))
      changed(threadId);
    if (!reply.ok) throw new Error(reply.error ?? "preview_failed");
    if (!kept) return;
    servers.set(threadId, reply.previews ?? []);
    changed(threadId);
  };
  /** Also holds the thread's detected dev servers, so the daemon pushes their changes. */
  const readServers = (threadId: string) => previews(threadId, { op: "list", suggestions: true });
  const link = async (threadId: string, port: number): Promise<PreviewLink> => {
    const reply = await request({
      type: "preview.request",
      threadId: ThreadId.parse(threadId),
      operation: { op: "link", port },
    });
    if (!reply.ok || !reply.link) throw new Error(reply.error ?? "preview_link_refused");
    return reply.link;
  };
  const sendCapture = (threadId: string, watch: Watch | undefined) => {
    const viewport = captures.get(threadId);
    if (!watch?.subscribed || !viewport || client.state !== "ready") return;
    void request({
      type: "browser.capture",
      threadId: ThreadId.parse(threadId),
      viewport,
    }).catch(() => {});
  };
  /** Reads the dev servers and retries the browser, every few seconds while the page shows. */
  const poll = (threadId: string) => {
    const watch = watches.get(threadId);
    if (disposed || !watch || client.state !== "ready" || !visibility.visible()) return;
    void readServers(threadId).catch(() => {});
    if (!watch.subscribed && !watch.subscribing) {
      watch.subscribing = true;
      const generation = watch.generation;
      const reported = captures.get(threadId);
      void subscribe(threadId)
        .then(
          () => {
            // A view that left and came back meanwhile (a tab replaced by another, a remount)
            // is served by this same subscription; only nobody watching gives it up.
            const current = watches.get(threadId);
            if (current === watch && current.generation === generation) {
              current.subscribed = true;
              // The subscribe carried the pane as it was; tell a change made since.
              if (captures.get(threadId) !== reported) sendCapture(threadId, current);
              releasePane(threadId);
            } else if (!current && !disposed)
              void call("browser.unsubscribe", threadId).catch(() => {});
          },
          () => {},
        )
        .finally(() => {
          watch.subscribing = false;
          // State can follow the initial frame. Replay resets that viewer's backpressure
          // without acknowledging a decode from a previous lifetime.
          if (watches.get(threadId) === watch && watch.generation !== generation) poll(threadId);
          else if (watches.get(threadId) && watches.get(threadId) !== watch) poll(threadId);
        });
    }
    watch.cancel?.();
    watch.cancel = later(() => poll(threadId), retryMs);
  };
  /** ACKs video chunks up to `sequence` (cumulative); `keyframe` asks for a fresh start. */
  const ack = (threadId: string, sequence: number, keyframe: boolean) => {
    try {
      client.send({
        type: "browser.ack",
        requestId: requestId(),
        threadId: ThreadId.parse(threadId),
        sequence,
        video: true,
        ...(keyframe ? { keyframe: true } : {}),
      });
    } catch {
      // Offline: the subscription ended with the connection.
    }
  };
  const receive = (message: ServerMessage) => {
    if (disposed) return;
    if (message.type === "preview.suggestions") {
      const { threadId } = message;
      if (!watches.has(threadId) && !unwatched.has(threadId)) return;
      if (suggestions.set(threadId, message.suggestions)) changed(threadId);
      return;
    }
    if (message.type === "browser.download.progress") {
      download =
        message.phase === "ready"
          ? undefined
          : {
              phase: message.phase,
              fraction: message.total ? Math.min(1, message.received / message.total) : undefined,
            };
      changed();
      return;
    }
    if (message.type === "browser.state") {
      const state = message.state;
      const watch = watches.get(state.threadId);
      if (!watch) return;
      const previous = views.get(state.threadId);
      if (
        watch &&
        ((state.closed && !previous?.closed) ||
          ((state.status === "paused" || state.status === "recovering") &&
            previous?.status !== state.status) ||
          (previous &&
            (previous.backend !== state.backend || previous.activeTabId !== state.activeTabId)))
      ) {
        if (previous?.activeTabId && previous.activeTabId !== state.activeTabId)
          keepStill(state.threadId, previous.activeTabId);
        invalidate(state.threadId, watch);
        if (state.closed) dropPicture(state.threadId);
        watch.subscribed = false;
        if (!state.closed)
          queueMicrotask(() => {
            if (watches.get(state.threadId) === watch) poll(state.threadId);
          });
      }
      views.set(state.threadId, view(state));
      current.add(state.threadId);
      releasePane(state.threadId);
      if (state.tabs)
        pages.keep(
          state.threadId,
          state.tabs.map((tab) => tab.tabId),
        );
      changed(state.threadId);
      return;
    }
    if (message.type === "browser.page") {
      if (!watches.has(message.threadId)) return;
      if (pages.set(message.threadId, message.tabId, message.page)) changed(message.threadId);
    }
    // JPEG frames (`browser.frame`, as JSON or binary) are not a live view any more: ignored,
    // and never acked.
  };
  try {
    stops.push(client.onMessage(receive));
    const stopStream = client.onStream?.((message) => {
      if (message.kind === "browser.video" && !disposed)
        videos.receive(
          message.threadId,
          message.chunk,
          captures.get(message.threadId)?.nativeShown !== true,
        );
      else if (message.kind === "browser.audio" && !disposed && watches.has(message.threadId))
        sounds.receive(message.threadId, message.chunk);
    });
    if (stopStream) stops.push(stopStream);
    stops.push(
      client.connectionState().subscribe(() => {
        const ready = client.state === "ready";
        for (const [threadId, watch] of watches) {
          // The daemon dropped this connection's subscriptions.
          watch.subscribed = false;
          invalidate(threadId, watch);
          watch.cancel?.();
          if (ready) poll(threadId);
        }
      }),
    );
    stops.push(
      visibility.watch(() => {
        if (!visibility.visible()) return;
        for (const [threadId, watch] of watches) {
          if (seen(threadId)) videos.settle(threadId);
          watch.cancel?.();
          poll(threadId);
        }
      }),
    );
  } catch {
    // A closed client: nothing will arrive.
  }
  const resizePage: PreviewSource["resize"] = (
    threadId,
    width,
    height,
    touch,
    devicePixelRatio,
  ) => {
    void request({
      type: "browser.execute",
      threadId: ThreadId.parse(threadId),
      command: {
        action: "resize",
        width: clamp(width),
        height: clamp(height),
        ...(touch ? { touch } : {}),
        ...(devicePixelRatio === undefined
          ? {}
          : { devicePixelRatio: Math.min(4, Math.max(1, devicePixelRatio)) }),
      },
    }).catch(() => {});
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const stop of stops) stop();
      for (const watch of watches.values()) watch.cancel?.();
      watches.clear();
      for (const threadId of new Set([...frames.keys(), ...stills.keys()])) release(threadId);
      videos.dispose();
      sounds.dispose();
      views.clear();
      pages.clear();
      servers.clear();
      suggestions.clear();
      unwatched.clear();
      captures.clear();
      listeners.clear();
      download = undefined;
    },
    get version() {
      return version;
    },
    subscribe(listener, threadId) {
      if (disposed) return () => {};
      listeners.set(listener, threadId);
      return () => listeners.delete(listener);
    },
    watch(threadId) {
      if (disposed) return () => {};
      let watch = watches.get(threadId);
      if (watch) watch.count++;
      else {
        watch = {
          generation: 0,
          count: 1,
          subscribed: false,
          subscribing: false,
          cancel: undefined,
        };
        watches.set(threadId, watch);
        unwatched.delete(threadId);
        poll(threadId);
      }
      const current = watch;
      return () => {
        if (--current.count > 0) return;
        // Another view of the thread may take over in the same commit (one browser tab closes
        // as the next one shows): only a thread nobody watches once that settles is let go.
        queueMicrotask(() => {
          if (current.count > 0 || watches.get(threadId) !== current) return;
          stop();
        });
      };
      function stop() {
        watches.delete(threadId);
        current.cancel?.();
        // The subscription ends: a later view's stream starts from its own keyframe, and a
        // picture still decoding from this one is never shown or acked.
        videos.reset(threadId);
        // Nobody shows the page: its sound stops, and a later view starts muted again.
        sounds.set(threadId, false);
        const shown = captures.get(threadId);
        if (shown?.audio) captures.set(threadId, { ...shown, audio: false });
        unwatched.add(threadId);
        for (const oldest of unwatched) {
          if (unwatched.size <= keptThreads) break;
          unwatched.delete(oldest);
          release(oldest);
        }
        if (client.state !== "ready") return;
        // Invalidation clears subscribed to request replay, but the logical subscription
        // still owns a slot even when a hidden page cannot replay it yet.
        void call("browser.unsubscribe", threadId).catch(() => {});
      }
    },
    view: (threadId) => views.get(threadId),
    page: (threadId, tabId) => pages.get(threadId, tabId),
    frame: (threadId) => frames.get(threadId),
    decodesVideo: () => videos.decodes(),
    still: (threadId, tabId) => stills.get(threadId)?.get(tabId),
    servers: (threadId) => servers.get(threadId) ?? [],
    suggestions: (threadId) => suggestions.get(threadId),
    download: () => download,
    canForward: () => gateway,
    forward: (threadId, port) => previews(threadId, { op: "forward", port }),
    unforward: (threadId, port) => previews(threadId, { op: "unforward", port }),
    link,
    async open(threadId, workspaceId) {
      const reply = await request(
        {
          type: "browser.open",
          options: {
            threadId: ThreadId.parse(threadId),
            workspaceId: WorkspaceId.parse(workspaceId),
          },
        },
        { timeoutMs: openTimeoutMs },
      ).finally(() => {
        if (disposed || !download) return;
        download = undefined;
        changed();
      });
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
      const state = BrowserState.safeParse(reply.result);
      const watch = watches.get(threadId);
      if (watch) {
        if (state.success) {
          views.set(threadId, view(state.data));
          changed(threadId);
        }
        watch.cancel?.();
        poll(threadId);
      }
      return state.success ? view(state.data) : undefined;
    },
    async navigate(threadId, url, tabId) {
      const result = await execute(
        threadId,
        { action: "navigate", url, timeout: 30_000, ...(tabId ? { tabId } : {}) },
        // The daemon waits up to the command's timeout for the page; wait a little longer.
        35_000,
      );
      return reached(result, url);
    },
    async navigateHistory(threadId, direction, tabId) {
      await execute(threadId, { action: "history", direction, ...(tabId ? { tabId } : {}) });
    },
    findText(threadId, text, forward, tabId) {
      return execute(threadId, { action: "find_text", text, forward, ...(tabId ? { tabId } : {}) });
    },
    async emulate(threadId, emulation, tabId) {
      await execute(threadId, {
        action: "emulate",
        width: clamp(emulation.width),
        height: clamp(emulation.height),
        deviceScaleFactor: emulation.deviceScaleFactor,
        mobile: emulation.mobile,
        touch: emulation.touch,
        colorScheme: "no-preference",
        ...(emulation.userAgent ? { userAgent: emulation.userAgent } : {}),
        ...(tabId ? { tabId } : {}),
      });
    },
    async openTab(threadId, url) {
      const result = BrowserTabsResult.parse(
        await tabs({ type: "browser.tabs.open", ...(url ? { url } : {}) }, threadId),
      );
      if ("pending_dialog" in result) throw new Error("A page is waiting for an answer");
      return result.tabId ?? result.activeTabId;
    },
    async selectTab(threadId, tabId) {
      await tabs({ type: "browser.tabs.select", tabId }, threadId);
    },
    async listTabs(threadId) {
      const reply = await request({
        type: "browser.tabs.list",
        threadId: ThreadId.parse(threadId),
      });
      if (!reply.ok) return [];
      const listed = BrowserTabList.safeParse(reply.result);
      return listed.success ? listed.data.map(tabView) : [];
    },
    async closeTab(threadId, tabId) {
      await tabs({ type: "browser.tabs.close", tabId }, threadId);
    },
    async keepPrivate(threadId, tabId, value) {
      const reply = await request({
        type: "browser.tabs.private",
        threadId: ThreadId.parse(threadId),
        tabId,
        private: value,
      });
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    },
    pageTool(threadId, command, tabId) {
      // Printing a long page or capturing a full page can take a while.
      return execute(threadId, { ...command, ...(tabId ? { tabId } : {}) }, 60_000);
    },
    async screenshotSizes(threadId, tabId, sizes, fullPage) {
      return BrowserScreenshotSet.parse(
        await execute(
          threadId,
          { action: "screenshot", tabId, sizes: [...sizes], fullPage },
          // Three layouts and captures, each written to the thread's files.
          90_000,
        ),
      );
    },
    async logs(threadId, tabId) {
      return readBrowserLogs(await execute(threadId, { action: "logs", tabId, limit: 200 }));
    },
    async extensions(threadId): Promise<readonly BrowserExtensionView[]> {
      return Extensions.parse(await execute(threadId, { action: "extensions" })).extensions;
    },
    async close(threadId) {
      const watch = watches.get(threadId);
      if (watch) {
        invalidate(threadId, watch);
        dropPicture(threadId);
        watch.subscribed = false;
        changed(threadId);
      }
      await call("browser.close", threadId);
    },
    annotate,
    input(threadId, input, tabId) {
      return request({
        type: "browser.input",
        threadId: ThreadId.parse(threadId),
        input: wireInput(input),
        ...(tabId ? { tabId } : {}),
      })
        .then(() => {})
        .catch(() => {});
    },
    async selection(threadId, tabId) {
      const result = await execute(threadId, { action: "selection", ...(tabId ? { tabId } : {}) });
      return typeof result === "object" &&
        result !== null &&
        "text" in result &&
        typeof result.text === "string"
        ? result.text
        : "";
    },
    nativeShown(threadId, shown) {
      if (disposed) return;
      captures.set(threadId, { ...captureOf(threadId), nativeShown: shown });
      const watch = watches.get(threadId);
      sendCapture(threadId, watch);
      if (watch && seen(threadId)) videos.settle(threadId);
    },
    cursorStyle(threadId, style) {
      if (disposed) return;
      const before = captures.get(threadId)?.cursor;
      if (before?.fill === style.fill && before.outline === style.outline) return;
      captures.set(threadId, { ...captureOf(threadId), cursor: style });
      sendCapture(threadId, watches.get(threadId));
    },
    audio: (threadId) => (sounds.available ? sounds.on(threadId) : undefined),
    setAudio(threadId, on) {
      if (disposed || !sounds.available) return;
      sounds.set(threadId, on);
      captures.set(threadId, { ...captureOf(threadId), audio: on });
      sendCapture(threadId, watches.get(threadId));
      changed(threadId);
    },
    async stopRecording(threadId) {
      await call("browser.recording.stop", threadId);
    },
    capture(threadId, width, height, devicePixelRatio) {
      if (disposed) return;
      const before = captures.get(threadId);
      captures.set(threadId, {
        nativeShown: before?.nativeShown,
        ...(before?.cursor ? { cursor: before.cursor } : {}),
        ...(before?.audio ? { audio: true } : {}),
        width: clamp(width),
        height: clamp(height),
        devicePixelRatio: Math.min(4, Math.max(1, devicePixelRatio)),
      });
      sendCapture(threadId, watches.get(threadId));
    },
    resize: resizePage,
    fitPane(threadId, width, height, touch, devicePixelRatio) {
      panes.set(threadId, () => resizePage(threadId, width, height, touch, devicePixelRatio));
      releasePane(threadId);
    },
  };
}
