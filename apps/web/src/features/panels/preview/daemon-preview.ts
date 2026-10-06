import type { ClientApi } from "@ace/client";
import {
  BrowserState,
  ThreadId,
  WorkspaceId,
  type BrowserInput,
  type BrowserCaptureViewport,
  type ServerMessage,
} from "@ace/protocol";
import type {
  BrowserDownload,
  BrowserView,
  ForwardedInput,
  PreviewServer,
  PreviewSource,
  ScreenFrame,
} from "../sources.ts";
import { schedule as defaultSchedule, type Schedule } from "../schedule.ts";
import { documentVisibility, type PageVisibility } from "@/lib/page-visibility.ts";
import { decodeFrame, type FrameDecoder } from "./frames.ts";

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
  controller: state.controller,
  owner: state.owner,
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
    pendingDialog: tab.pending_dialog,
  })),
  activeTabId: state.activeTabId,
  downloads: state.downloads,
  pendingDialog: state.pending_dialog,
  takeoverMode: state.takeoverMode,
});

const wireInput = (input: ForwardedInput): BrowserInput => {
  if (input.kind === "mouse") return { ...input, button: "left", clickCount: 1 };
  if (input.kind === "scroll") return input;
  return {
    kind: "key",
    event: "keyDown",
    key: input.key,
    modifiers: 0,
    ...(input.text ? { text: input.text } : {}),
  };
};

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
  count: number;
  subscribed: boolean;
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
 * stream pauses until it is shown. Taking control is a lease on this connection; leaving the
 * view (or losing the connection) hands it back.
 */
export function daemonPreview(client: ClientApi, options: PreviewOptions = {}): PreviewSource {
  const later = options.schedule ?? defaultSchedule;
  const visibility = options.visibility ?? documentVisibility;
  const decode = options.decode ?? decodeFrame;
  const listeners = new Map<() => void, string | undefined>();
  const views = new Map<string, BrowserView>();
  const frames = new Map<string, Shown>();
  const servers = new Map<string, readonly PreviewServer[]>();
  const watches = new Map<string, Watch>();
  /** Threads no view shows any more, oldest first; their state goes past `keptThreads`. */
  const unwatched = new Set<string>();
  /**
   * Threads whose browser this client took control of, with the connection its take-control
   * reply named as the owner (undefined when the reply named none).
   */
  const held = new Map<string, string | undefined>();
  /** Threads this client took privately: their hold outlives the view (no automatic handback). */
  const privateHolds = new Set<string>();
  let version = 0;
  let requests = 0;
  let download: BrowserDownload | undefined;
  let gateway = true;
  /** A change to one thread (or, without one, to every thread: the download, the gateway). */
  const changed = (threadId?: string) => {
    version++;
    for (const [listener, scope] of listeners)
      if (scope === undefined || threadId === undefined || scope === threadId) listener();
  };
  const release = (threadId: string) => {
    frames.get(threadId)?.release();
    frames.delete(threadId);
    views.delete(threadId);
    servers.delete(threadId);
  };
  const requestId = () => `browser-${++requests}`;
  const call = async (
    type:
      | "browser.subscribe"
      | "browser.unsubscribe"
      | "browser.takeover"
      | "browser.handback"
      | "browser.close",
    threadId: string,
    mode?: "shared" | "private",
  ) => {
    const reply =
      type === "browser.takeover" && mode
        ? await client.request({ type, threadId: ThreadId.parse(threadId), mode })
        : await client.request({ type, threadId: ThreadId.parse(threadId) });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  const previews = async (
    threadId: string,
    operation: { op: "list" } | { op: "forward" | "unforward"; port: number },
  ) => {
    const reply = await client.request({
      type: "preview.request",
      threadId: ThreadId.parse(threadId),
      operation,
    });
    const available = reply.ok || reply.error !== "preview_unavailable";
    if (available !== gateway) {
      gateway = available;
      changed();
    }
    if (!reply.ok) throw new Error(reply.error ?? "preview_failed");
    if (!watches.has(threadId) && !unwatched.has(threadId)) return;
    servers.set(threadId, reply.previews ?? []);
    changed(threadId);
  };
  const readServers = (threadId: string) => previews(threadId, { op: "list" });
  const sendCapture = (threadId: string, watch: Watch) => {
    if (!watch.subscribed || !watch.capture || client.state !== "ready") return;
    void client
      .request({
        type: "browser.capture",
        threadId: ThreadId.parse(threadId),
        viewport: watch.capture,
      })
      .catch(() => {});
  };
  /** Reads the dev servers and retries the browser, every few seconds while the page shows. */
  const poll = (threadId: string) => {
    const watch = watches.get(threadId);
    if (!watch || client.state !== "ready" || !visibility.visible()) return;
    void readServers(threadId).catch(() => {});
    if (!watch.subscribed)
      call("browser.subscribe", threadId).then(
        () => {
          // A view that left and came back meanwhile (a tab replaced by another, a remount)
          // is served by this same subscription; only nobody watching gives it up.
          const current = watches.get(threadId);
          if (current) {
            current.subscribed = true;
            sendCapture(threadId, current);
          } else void call("browser.unsubscribe", threadId).catch(() => {});
        },
        () => {},
      );
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
  const show = (threadId: string, sequence: number, frame: Shown) => {
    const watch = watches.get(threadId);
    if (!watch || watch.latest !== sequence) return frame.release();
    frames.get(threadId)?.release();
    frames.set(threadId, frame);
    changed(threadId);
    if (visibility.visible()) ack(threadId, sequence);
    else watch.owed = sequence;
  };
  const receive = (message: ServerMessage) => {
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
      if (!watches.has(state.threadId)) return;
      views.set(state.threadId, view(state));
      if (state.controller !== "human") held.delete(state.threadId);
      if (state.takeoverMode !== "private") privateHolds.delete(state.threadId);
      changed(state.threadId);
      return;
    }
    if (message.type !== "browser.frame") return;
    const { threadId, frame } = message;
    const watch = watches.get(threadId);
    if (!watch) return;
    watch.latest = frame.sequence;
    void decode(frame.data).then(
      (decoded) =>
        show(threadId, frame.sequence, {
          sequence: frame.sequence,
          src: decoded.src,
          width: frame.width,
          height: frame.height,
          release: decoded.release,
        }),
      // A frame that cannot be decoded is skipped; the next one may.
      () => {
        if (watches.get(threadId)?.latest === frame.sequence) ack(threadId, frame.sequence);
      },
    );
  };
  try {
    client.onMessage(receive);
    client.connectionState().subscribe(() => {
      const ready = client.state === "ready";
      for (const [threadId, watch] of watches) {
        // The daemon dropped this connection's subscriptions and control leases.
        watch.subscribed = false;
        watch.owed = undefined;
        held.delete(threadId);
        watch.cancel?.();
        if (ready) poll(threadId);
      }
    });
    visibility.watch(() => {
      if (!visibility.visible()) return;
      for (const [threadId, watch] of watches) {
        if (watch.owed !== undefined) ack(threadId, watch.owed);
        watch.owed = undefined;
        watch.cancel?.();
        poll(threadId);
      }
    });
  } catch {
    // A closed client: nothing will arrive.
  }
  return {
    get version() {
      return version;
    },
    subscribe(listener, threadId) {
      listeners.set(listener, threadId);
      return () => listeners.delete(listener);
    },
    watch(threadId) {
      let watch = watches.get(threadId);
      if (watch) watch.count++;
      else {
        watch = {
          count: 1,
          subscribed: false,
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
        watches.delete(threadId);
        current.cancel?.();
        unwatched.add(threadId);
        for (const oldest of unwatched) {
          if (unwatched.size <= keptThreads) break;
          unwatched.delete(oldest);
          release(oldest);
        }
        if (client.state !== "ready") return;
        // A shared hold ends with the view; a private one never does: only the person's own
        // Hand back (or closing the browser) may show the page to agents again.
        const privately =
          privateHolds.has(threadId) || views.get(threadId)?.takeoverMode === "private";
        if (!privately && held.delete(threadId))
          void call("browser.handback", threadId).catch(() => {});
        if (current.subscribed) void call("browser.unsubscribe", threadId).catch(() => {});
      };
    },
    view: (threadId) => views.get(threadId),
    frame: (threadId) => frames.get(threadId),
    servers: (threadId) => servers.get(threadId) ?? [],
    download: () => download,
    canForward: () => gateway,
    forward: (threadId, port) => previews(threadId, { op: "forward", port }),
    unforward: (threadId, port) => previews(threadId, { op: "unforward", port }),
    async open(threadId, workspaceId) {
      const reply = await client
        .request(
          {
            type: "browser.open",
            options: {
              threadId: ThreadId.parse(threadId),
              workspaceId: WorkspaceId.parse(workspaceId),
            },
          },
          { timeoutMs: openTimeoutMs },
        )
        .finally(() => {
          if (!download) return;
          download = undefined;
          changed();
        });
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
      const watch = watches.get(threadId);
      if (watch) {
        watch.cancel?.();
        poll(threadId);
      }
    },
    async navigate(threadId, url) {
      const reply = await client.request(
        {
          type: "browser.execute",
          threadId: ThreadId.parse(threadId),
          command: { action: "navigate", url, timeout: 30_000 },
        },
        // The daemon waits up to the command's timeout for the page; wait a little longer.
        { timeoutMs: 35_000 },
      );
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
      return reached(reply.result, url);
    },
    async emulate(threadId, emulation) {
      const reply = await client.request({
        type: "browser.execute",
        threadId: ThreadId.parse(threadId),
        command: {
          action: "emulate",
          width: clamp(emulation.width),
          height: clamp(emulation.height),
          deviceScaleFactor: emulation.deviceScaleFactor,
          mobile: emulation.mobile,
          touch: emulation.touch,
          colorScheme: "no-preference",
        },
      });
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    },
    async close(threadId) {
      held.delete(threadId);
      privateHolds.delete(threadId);
      await call("browser.close", threadId);
    },
    async takeover(threadId, mode) {
      const state = BrowserState.safeParse(await call("browser.takeover", threadId, mode));
      if (mode === "private") privateHolds.add(threadId);
      held.set(threadId, state.success ? state.data.owner : undefined);
    },
    heldAs(threadId) {
      const owner = held.get(threadId);
      const current = views.get(threadId);
      return owner !== undefined && current?.controller === "human" && current.owner === owner
        ? owner
        : undefined;
    },
    async handback(threadId) {
      held.delete(threadId);
      privateHolds.delete(threadId);
      await call("browser.handback", threadId);
    },
    input(threadId, input) {
      void client
        .request({
          type: "browser.input",
          threadId: ThreadId.parse(threadId),
          input: wireInput(input),
        })
        .catch(() => {});
    },
    capture(threadId, width, height, devicePixelRatio) {
      const watch = watches.get(threadId);
      if (!watch) return;
      watch.capture = {
        width: clamp(width),
        height: clamp(height),
        devicePixelRatio: Math.min(4, Math.max(1, devicePixelRatio)),
      };
      sendCapture(threadId, watch);
    },
    resize(threadId, width, height) {
      void client
        .request({
          type: "browser.execute",
          threadId: ThreadId.parse(threadId),
          command: { action: "resize", width: clamp(width), height: clamp(height) },
        })
        .catch(() => {});
    },
  };
}
