import { z } from "zod";
import type { ClientApi } from "@ace/client";
import {
  BrowserScreenshotSet,
  BrowserState,
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
  BrowserView,
  ForwardedInput,
  PreviewLink,
  PreviewServer,
  PreviewSource,
  ScreenFrame,
} from "../sources.ts";
import { schedule as defaultSchedule, type Schedule } from "../schedule.ts";
import { documentVisibility, type PageVisibility } from "@/lib/page-visibility.ts";
import { daemonAnnotate } from "./daemon-annotate.ts";
import { decodeFrame, type FrameDecoder } from "./frames.ts";
import { SuggestionStore } from "./preview-suggestions.ts";
import { readBrowserLogs } from "./browser-logs.ts";

/** How often a watched thread without a browser asks again, and re-reads its dev servers. */
const retryMs = 5_000;
/** The daemon gives up on a Chromium download after 10 minutes; wait a little longer. */
const openTimeoutMs = 660_000;
/** Threads no view shows whose last browser state and frame are kept, so coming back is instant. */
const keptThreads = 8;
/** BrowserCommand `resize` bounds. */
const clamp = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));

const view = (state: BrowserState): BrowserView => ({
  threadId: state.threadId,
  url: state.url,
  closed: state.closed,
  status: state.status,
  reason: state.reason,
  backend: state.backend,
  pageStateLost: state.pageStateLost,
  tabs: state.tabs?.map((tab) => ({
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
  })),
  activeTabId: state.activeTabId,
  loading: state.loading,
  loadError: state.loadError,
  permissionDenied: state.permissionDenied,
  downloads: state.downloads,
  pendingDialog: state.pending_dialog,
  annotation: state.annotation,
  features: state.features,
});

const wireInput = (input: ForwardedInput): BrowserInput => {
  if (input.kind === "mouse")
    return { ...input, button: input.button ?? "left", clickCount: input.clickCount ?? 1 };
  if (input.kind === "scroll") return input;
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
  capture?: BrowserCaptureViewport;
  /** Cancels the next poll. */
  cancel: (() => void) | undefined;
  /** The newest frame received; an older one still decoding is dropped when it lands. */
  latest: number | undefined;
  /** A frame drawn while the page was hidden: ACKed once it is shown. */
  owed: number | undefined;
}

interface Shown extends ScreenFrame {
  release(): void;
}

export interface PreviewOptions {
  schedule?: Schedule;
  visibility?: PageVisibility;
  decode?: FrameDecoder;
}

/**
 * The thread's browser through the daemon's browser relay (ADR 0055) and its dev servers through
 * the preview gateway. Frames are ACKed one at a time once decoded, so the daemon never sends a
 * viewer more than it can draw; while the page is hidden nothing is ACKed or polled, so the
 * stream pauses until it is shown. People and agents share every tab: nothing is taken or
 * handed back, and the person's commands name the tab they act in.
 */
export function daemonPreview(client: ClientApi, options: PreviewOptions = {}): PreviewSource {
  const lifetime = new AbortController();
  const request: ClientApi["request"] = (payload, requestOptions) =>
    client.request(payload, { ...requestOptions, signal: lifetime.signal });
  const later = options.schedule ?? defaultSchedule;
  const visibility = options.visibility ?? documentVisibility;
  const decode = options.decode ?? decodeFrame;
  const listeners = new Map<() => void, string | undefined>();
  const views = new Map<string, BrowserView>();
  const frames = new Map<string, Shown>();
  const servers = new Map<string, readonly PreviewServer[]>();
  const suggestions = new SuggestionStore();
  const watches = new Map<string, Watch>();
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
  const release = (threadId: string) => {
    frames.get(threadId)?.release();
    frames.delete(threadId);
    views.delete(threadId);
    servers.delete(threadId);
    suggestions.delete(threadId);
  };
  const invalidate = (threadId: string, watch: Watch) => {
    watch.generation++;
    watch.latest = undefined;
    watch.owed = undefined;
    frames.get(threadId)?.release();
    frames.delete(threadId);
  };
  const requestId = () => `browser-${++requests}`;
  const call = async (
    type: "browser.subscribe" | "browser.unsubscribe" | "browser.close",
    threadId: string,
  ) => {
    if (disposed) throw new Error("preview_disposed");
    const reply = await request({ type, threadId: ThreadId.parse(threadId) });
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
  const sendCapture = (threadId: string, watch: Watch) => {
    if (!watch.subscribed || !watch.capture || client.state !== "ready") return;
    void request({
      type: "browser.capture",
      threadId: ThreadId.parse(threadId),
      viewport: watch.capture,
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
      void call("browser.subscribe", threadId)
        .then(
          () => {
            // A view that left and came back meanwhile (a tab replaced by another, a remount)
            // is served by this same subscription; only nobody watching gives it up.
            const current = watches.get(threadId);
            if (current === watch && current.generation === generation) {
              current.subscribed = true;
              sendCapture(threadId, current);
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
  const ack = (threadId: string, sequence: number) => {
    try {
      client.send({
        type: "browser.ack",
        requestId: requestId(),
        threadId: ThreadId.parse(threadId),
        sequence,
      });
    } catch {
      // Offline: the subscription ended with the connection.
    }
  };
  /** Show a decoded frame, then ask for the next one (later, if the page is hidden). */
  const currentFrame = (threadId: string, watch: Watch, generation: number, sequence: number) =>
    watches.get(threadId) === watch && watch.generation === generation && watch.latest === sequence;
  const show = (
    threadId: string,
    watch: Watch,
    generation: number,
    sequence: number,
    frame: Shown,
  ) => {
    if (!currentFrame(threadId, watch, generation, sequence)) return frame.release();
    frames.get(threadId)?.release();
    frames.set(threadId, frame);
    changed(threadId);
    if (visibility.visible()) ack(threadId, sequence);
    else watch.owed = sequence;
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
        invalidate(state.threadId, watch);
        watch.subscribed = false;
        if (!state.closed)
          queueMicrotask(() => {
            if (watches.get(state.threadId) === watch) poll(state.threadId);
          });
      }
      views.set(state.threadId, view(state));
      changed(state.threadId);
      return;
    }
    if (message.type !== "browser.frame") return;
    const { threadId, frame } = message;
    const watch = watches.get(threadId);
    if (!watch) return;
    const generation = watch.generation;
    watch.latest = frame.sequence;
    if (watch.capture?.nativeShown) {
      watch.owed = frame.sequence;
      return;
    }
    void decode(frame.data).then(
      (decoded) =>
        show(threadId, watch, generation, frame.sequence, {
          sequence: frame.sequence,
          src: decoded.src,
          width: frame.width,
          height: frame.height,
          release: decoded.release,
        }),
      // A frame that cannot be decoded is skipped; the next one may.
      () => {
        if (currentFrame(threadId, watch, generation, frame.sequence))
          ack(threadId, frame.sequence);
      },
    );
  };
  try {
    stops.push(client.onMessage(receive));
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
          if (watch.owed !== undefined) ack(threadId, watch.owed);
          watch.owed = undefined;
          watch.cancel?.();
          poll(threadId);
        }
      }),
    );
  } catch {
    // A closed client: nothing will arrive.
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const stop of stops) stop();
      for (const watch of watches.values()) watch.cancel?.();
      watches.clear();
      for (const threadId of frames.keys()) release(threadId);
      views.clear();
      servers.clear();
      suggestions.clear();
      unwatched.clear();
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
          latest: undefined,
          owed: undefined,
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
    frame: (threadId) => frames.get(threadId),
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
    async navigationHistory(threadId, tabId) {
      return z
        .object({ back: z.boolean(), forward: z.boolean() })
        .parse(
          await execute(threadId, { action: "navigation_history", ...(tabId ? { tabId } : {}) }),
        );
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
      const watch = watches.get(threadId);
      if (!watch) return;
      watch.capture = {
        ...(watch.capture ?? { width: 1280, height: 720, devicePixelRatio: 1 }),
        nativeShown: shown,
      };
      sendCapture(threadId, watch);
      if (!shown && watch.owed !== undefined) {
        ack(threadId, watch.owed);
        watch.owed = undefined;
      }
    },
    capture(threadId, width, height, devicePixelRatio) {
      const watch = watches.get(threadId);
      if (!watch) return;
      watch.capture = {
        nativeShown: watch.capture?.nativeShown,
        width: clamp(width),
        height: clamp(height),
        devicePixelRatio: Math.min(4, Math.max(1, devicePixelRatio)),
      };
      sendCapture(threadId, watch);
    },
    resize(threadId, width, height) {
      void request({
        type: "browser.execute",
        threadId: ThreadId.parse(threadId),
        command: { action: "resize", width: clamp(width), height: clamp(height) },
      }).catch(() => {});
    },
  };
}
