import type { ClientApi } from "@ace/client";
import {
  ThreadId,
  WorkspaceId,
  type BrowserInput,
  type BrowserState,
  type ServerMessage,
} from "@ace/protocol";
import type {
  BrowserView,
  ForwardedInput,
  PreviewServer,
  PreviewSource,
  ScreenFrame,
} from "../sources.ts";

/** How often a watched thread without a browser asks again, and re-reads its dev servers. */
const retryMs = 5_000;
/** BrowserCommand `resize` bounds. */
const clamp = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));

/** The daemon sends base64 JPEG screencast frames; the fake sends ready-made data URLs. */
export function frameSource(data: string): string {
  return data.startsWith("data:") ? data : `data:image/jpeg;base64,${data}`;
}

const view = (state: BrowserState): BrowserView => ({
  threadId: state.threadId,
  controller: state.controller,
  owner: state.owner,
  url: state.url,
  closed: state.closed,
  status: state.status,
  reason: state.reason,
});

const wireInput = (input: ForwardedInput): BrowserInput =>
  input.kind === "mouse"
    ? { ...input, button: "left", clickCount: 1 }
    : {
        kind: "key",
        event: "keyDown",
        key: input.key,
        modifiers: 0,
        ...(input.text ? { text: input.text } : {}),
      };

interface Watch {
  count: number;
  subscribed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The thread's browser through the daemon's browser relay (ADR 0055) and its dev servers through
 * the preview gateway. Frames are ACKed one at a time, so the daemon never sends a viewer more
 * than it has drawn. Taking control is a lease on this connection; leaving the view (or losing
 * the connection) hands it back.
 */
export function daemonPreview(
  client: ClientApi,
  timers: {
    set(ms: number, callback: () => void): ReturnType<typeof setTimeout>;
    clear(timer: ReturnType<typeof setTimeout> | undefined): void;
  } = { set: (ms, callback) => setTimeout(callback, ms), clear: (timer) => clearTimeout(timer) },
): PreviewSource {
  const listeners = new Set<() => void>();
  const views = new Map<string, BrowserView>();
  const frames = new Map<string, ScreenFrame>();
  const servers = new Map<string, readonly PreviewServer[]>();
  const watches = new Map<string, Watch>();
  /** Threads whose browser this client took control of. */
  const held = new Set<string>();
  let version = 0;
  let requests = 0;
  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const requestId = () => `browser-${++requests}`;
  const call = async (
    type: "browser.subscribe" | "browser.unsubscribe" | "browser.takeover" | "browser.handback",
    threadId: string,
  ) => {
    const reply = await client.request({ type, threadId: ThreadId.parse(threadId) });
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  const readServers = async (threadId: string) => {
    const reply = await client.request({
      type: "preview.request",
      threadId: ThreadId.parse(threadId),
      operation: { op: "list" },
    });
    if (!reply.ok) return;
    servers.set(threadId, reply.previews ?? []);
    changed();
  };
  const poll = (threadId: string) => {
    const watch = watches.get(threadId);
    if (!watch || client.state !== "ready") return;
    void readServers(threadId).catch(() => {});
    if (!watch.subscribed)
      call("browser.subscribe", threadId).then(
        () => {
          if (watches.get(threadId) === watch) watch.subscribed = true;
          else void call("browser.unsubscribe", threadId).catch(() => {});
        },
        () => {},
      );
    watch.timer = timers.set(retryMs, () => poll(threadId));
  };
  const receive = (message: ServerMessage) => {
    if (message.type === "browser.state") {
      const state = message.state;
      if (!watches.has(state.threadId)) return;
      views.set(state.threadId, view(state));
      if (state.controller !== "human") held.delete(state.threadId);
      changed();
      return;
    }
    if (message.type !== "browser.frame" || !watches.has(message.threadId)) return;
    const frame = message.frame;
    frames.set(message.threadId, {
      sequence: frame.sequence,
      src: frameSource(frame.data),
      width: frame.width,
      height: frame.height,
    });
    changed();
    try {
      client.send({
        type: "browser.ack",
        requestId: requestId(),
        threadId: message.threadId,
        sequence: frame.sequence,
      });
    } catch {
      // Offline: the subscription ended with the connection.
    }
  };
  try {
    client.onMessage(receive);
    client.connectionState().subscribe(() => {
      const ready = client.state === "ready";
      for (const [threadId, watch] of watches) {
        // The daemon dropped this connection's subscriptions and control leases.
        watch.subscribed = false;
        held.delete(threadId);
        timers.clear(watch.timer);
        if (ready) poll(threadId);
      }
    });
  } catch {
    // A closed client: nothing will arrive.
  }
  return {
    get version() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch(threadId) {
      let watch = watches.get(threadId);
      if (watch) watch.count++;
      else {
        watch = { count: 1, subscribed: false, timer: undefined };
        watches.set(threadId, watch);
        poll(threadId);
      }
      const current = watch;
      return () => {
        if (--current.count > 0) return;
        watches.delete(threadId);
        timers.clear(current.timer);
        if (client.state !== "ready") return;
        if (held.delete(threadId)) void call("browser.handback", threadId).catch(() => {});
        if (current.subscribed) void call("browser.unsubscribe", threadId).catch(() => {});
      };
    },
    view: (threadId) => views.get(threadId),
    frame: (threadId) => frames.get(threadId),
    servers: (threadId) => servers.get(threadId) ?? [],
    async open(threadId, workspaceId) {
      const reply = await client.request({
        type: "browser.open",
        options: {
          threadId: ThreadId.parse(threadId),
          workspaceId: WorkspaceId.parse(workspaceId),
        },
      });
      if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
      const watch = watches.get(threadId);
      if (watch) {
        timers.clear(watch.timer);
        poll(threadId);
      }
    },
    async takeover(threadId) {
      await call("browser.takeover", threadId);
      held.add(threadId);
    },
    async handback(threadId) {
      held.delete(threadId);
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
