import { BrowserOriginError } from "./policy.ts";
import {
  ThreadId,
  BrowserClientMessage,
  type BrowserCaptureViewport,
  type BrowserVideoRequest,
  type BrowserDownloadRead,
  type BrowserServerMessage,
  type BrowserState,
  type DeviceScope,
} from "@ace/protocol";
import type { BrowserService } from "./service.ts";
import type { EnginePreferencePort } from "./engine-move.ts";
import type { CaptureViewer } from "./viewer-sink.ts";
import { downloadBusy, encodeDownloadChunk } from "./stream-download.ts";
import {
  mediaSubscribed,
  mediaUndelivered,
  pendingUndelivered,
  updateReason,
  viewLink,
  viewSwap,
  viewViewport,
  type MediaDeliveryPort,
} from "@ace/media/media-viewers";
import type { MediaOwner } from "@ace/media/media-connections";

type BrowserAccess = Extract<DeviceScope, "read" | "operate">;

/** The ace-media sources that show a thread's browser. */
const showsThread = (threadId: string) => (producer: { threadId?: string | undefined }) =>
  producer.threadId === threadId;

function requiredAccess(message: BrowserClientMessage): BrowserAccess {
  if (
    ["browser.subscribe", "browser.unsubscribe", "browser.ack", "browser.capture"].includes(
      message.type,
    )
  )
    return "read";
  if (
    message.type === "browser.execute" &&
    [
      "snapshot",
      "screenshot",
      "logs",
      "wait_for",
      "find",
      "network_body",
      "navigation_history",
      "find_text",
      "selection",
      "page_source",
      "context_target",
      "image_data",
    ].includes(message.command.action)
  )
    return "read";
  if (
    ["browser.tabs.list", "browser.downloads.list", "browser.download.read"].includes(message.type)
  )
    return "read";
  return "operate";
}

/** Caller supplies an authenticated connection and thread authorization. */
export function connectBrowser(
  service: BrowserService,
  options: {
    connectionId: string;
    authorize: (
      threadId: string,
      workspaceId: string | undefined,
      access: BrowserAccess,
    ) => boolean;
    send: (message: BrowserServerMessage, serialized?: string) => boolean;
    /**
     * Sends one download chunk's binary stream messages (`@ace/browser/stream`), all of them or
     * none; false is backpressure. Without it, downloads can't be read here. Live video never
     * goes this way: ace-media delivers it on the client's media connection.
     */
    sendStream?: (pieces: readonly Uint8Array[]) => boolean;
    /** The connection is on this machine (the daemon's loopback listener, never a client claim). */
    local?: boolean;
    /**
     * Delivery by ace-media (D1) for subscribes that name a media connection, with who this
     * connection is: its session, device and admission (a main session, or a channel of its
     * own). Without it, or while ace-media doesn't serve, a subscribe gets no pictures and its
     * reply says why (`undelivered`).
     */
    media?: { owner: () => MediaOwner | undefined; delivery: () => MediaDeliveryPort | undefined };
    /**
     * Opens a thread attachment this connection uploaded (the files a person picks for a page's
     * file input). Without it, picking files is refused.
     */
    attachment?: (
      threadId: string,
      sha256: string,
    ) => Promise<{ chunks: AsyncIterable<Uint8Array>; close(): Promise<void> }>;
    /** Where the daemon keeps each thread's engine. Without it, engine moves are refused. */
    engine?: EnginePreferencePort;
  },
): { handle(raw: unknown): Promise<void>; close(): void } {
  /** `video`: the codecs this connection's viewers of the thread decode (ADR 0088). */
  type Subscription = {
    stop(): void;
    subscribers: Set<string>;
    video?: BrowserVideoRequest | undefined;
    /**
     * Each subscriber ace-media delivers to, with the media connection it named. The capture
     * runs here, so the producer streams into ace-media; nothing goes on this socket.
     */
    media: Map<string, string>;
    /** Subscribers from clients older than X3 (no `mediaClient`): no picture will reach them. */
    old: Set<string>;
    /** Subscribers that read `browser.delivery` (`deliveryStatus`): only they are sent one. */
    status: Set<string>;
    /**
     * The one view ace-media holds per media connection for this thread: a client can't tell two
     * views of one thread apart, so its subscribers there share it (fanned out client-side).
     */
    views: Map<string, string>;
    /** The view the capture was last told about, to tell it again when delivery changes. */
    shown?: CaptureViewer | undefined;
  };
  /**
   * This connection's view as the daemon's capture sees it: delivered by ace-media while any
   * subscriber is, so the capture runs ace-media's plan for it. A subscriber ace-media doesn't
   * deliver gets no pictures at all, so it never keeps a capture running.
   */
  const deliveredBy = (entry: Subscription, capture: CaptureViewer): CaptureViewer =>
    entry.media.size > 0 ? { ...capture, delivered: true } : capture;
  /**
   * A subscriber leaves its media connection's view: the view to close when it was the last one
   * there (the caller closes it, so a subscribe can close it only once it has succeeded).
   */
  const leave = (entry: Subscription | undefined, subscriber: string): string | undefined => {
    const connection = entry?.media.get(subscriber);
    if (!entry || connection === undefined) return undefined;
    entry.media.delete(subscriber);
    if ([...entry.media.values()].includes(connection)) return undefined;
    const mediaViewer = entry.views.get(connection);
    entry.views.delete(connection);
    return mediaViewer;
  };
  /** A subscriber leaves its media connection's view; the last one out closes it. */
  const retire = (entry: Subscription | undefined, subscriber: string) => {
    const mediaViewer = leave(entry, subscriber);
    if (mediaViewer !== undefined) options.media?.delivery()?.unbind(mediaViewer);
  };
  /**
   * The thread's state as this connection sees it: while only older clients watch it here, it
   * says why their view is empty in the fields they already show (paused, page state lost, the
   * reason), since they can't read `undelivered`.
   */
  const forPeer = (entry: Subscription | undefined, state: BrowserState): BrowserState =>
    entry && entry.media.size === 0 && entry.old.size > 0
      ? { ...state, status: "paused", pageStateLost: true, reason: updateReason }
      : state;
  const subscriptions = new Map<string, Subscription>();
  const sendStream = options.sendStream;
  const bind = (threadId: string, entry: Subscription, capture?: CaptureViewer) => {
    entry.stop = service.subscribe(
      threadId,
      options.connectionId,
      options.local === true ? { local: true } : {},
      (state) => options.send({ type: "browser.state", state: forPeer(entry, state) }),
      (event) => options.send(event),
      capture,
    );
  };
  /**
   * A subscribe naming a media connection: its viewer on that connection, when ace-media
   * delivers this browser's video now. A connection of another session is refused; otherwise,
   * while ace-media doesn't serve, the subscribe gets no pictures (its reply says why).
   */
  const bindMedia = (
    threadId: string,
    connection: string,
    message: Extract<BrowserClientMessage, { type: "browser.subscribe" }>,
    entry: Subscription | undefined,
  ): { viewer: string; created: boolean } | undefined => {
    const media = options.media;
    const delivery = media?.delivery();
    const owner = media?.owner();
    // The thread's own source: a kind ace-media serves elsewhere is no help to this one.
    const kind = service.videoKind(threadId);
    if (!owner || !delivery || !kind || !delivery.serves(kind)) return undefined;
    // Another subscriber of this thread already has the connection's view: share it.
    const shared = entry?.views.get(connection);
    if (shared !== undefined) return { viewer: shared, created: false };
    const viewport = message.viewport;
    const link = viewLink(viewport?.link);
    const bound = delivery.bind({
      requester: owner,
      connection,
      target: { kind: "browser", threadId },
      codecs: message.video?.codecs ?? ["avc1.42E033"],
      viewport: viewViewport(viewport ?? { width: 1280, height: 800, devicePixelRatio: 1 }),
      local: options.local === true,
      audio: viewport?.audio === true,
      ...(link ? { link } : {}),
      shows: showsThread(threadId),
      onGrant: (granted, refused) => delivered(threadId, granted, refused),
    });
    if (bound === undefined)
      throw new Error("media-connection: that media connection isn't this session's");
    return { viewer: bound, created: true };
  };
  /**
   * Tells this connection whether its bound view of the thread gets pictures now: on every
   * change of the view's grant in ace-media, with the reason while it doesn't.
   */
  const delivered = (threadId: string, granted: boolean, refused?: string) => {
    // Only a subscriber that asked reads it: an older decoder refuses an unknown message type.
    if (closed || !subscriptions.get(threadId)?.status.size) return;
    const port = options.media?.delivery();
    const kind = service.videoKind(threadId);
    const undelivered = granted
      ? undefined
      : pendingUndelivered(
          port?.sourceState(showsThread(threadId)) ?? "pending",
          kind ? port?.unserved(kind) : undefined,
          refused,
        );
    options.send({
      type: "browser.delivery",
      threadId: ThreadId.parse(threadId),
      ...(undelivered ? { undelivered } : {}),
    });
  };
  /** Why this thread's view gets no pictures: the reason for its own source's kind. */
  const browserUndelivered = (threadId: string, named: boolean) => {
    const kind = service.videoKind(threadId);
    if (named && !kind)
      return { code: "unavailable", reason: "This browser can't stream live video here." };
    return mediaUndelivered(named, options.media?.delivery(), kind ? [kind] : []);
  };
  let pending = 0;
  let closed = false;
  // Download chunks' stream message ids, apart from the service's frame ids.
  let streamId = 0x80000000;
  return {
    async handle(raw) {
      const message = BrowserClientMessage.parse(raw);
      if (closed) return;
      const threadId =
        message.type === "browser.open" ? message.options.threadId : message.threadId;
      const respond = (result: unknown) => {
        if (!closed)
          options.send({ type: "browser.result", requestId: message.requestId, ok: true, result });
      };
      let counted = false;
      try {
        if (
          !options.authorize(
            threadId,
            message.type === "browser.open"
              ? message.options.workspaceId
              : message.type === "browser.engine.move"
                ? message.workspaceId
                : undefined,
            requiredAccess(message),
          )
        )
          throw new Error("Browser thread access denied");
        if (pending >= 32) throw new Error("Too many pending browser requests");
        pending++;
        counted = true;
        switch (message.type) {
          case "browser.tabs.list":
            respond(service.state(threadId).tabs ?? []);
            break;
          case "browser.downloads.list":
            respond(service.downloadsList(threadId));
            break;
          case "browser.tabs.open":
          case "browser.tabs.switch":
          case "browser.tabs.select":
          case "browser.tabs.close":
            respond(
              await service.execute(
                threadId,
                {
                  action: "tabs",
                  operation: message.type.split(".")[2],
                  ...("tabId" in message ? { tabId: message.tabId } : {}),
                  ...("url" in message ? { url: message.url } : {}),
                },
                { kind: "human", connectionId: options.connectionId },
              ),
            );
            break;
          case "browser.dialog.answer":
            respond(
              await service.execute(
                threadId,
                {
                  action: "dialog",
                  tabId: message.tabId,
                  dialogId: message.dialogId,
                  accept: message.accept,
                  promptText: message.promptText,
                },
                { kind: "human", connectionId: options.connectionId },
              ),
            );
            break;
          case "browser.open": {
            const stopProgress = service.downloadProgress((progress) => {
              if (!closed) options.send(progress);
            });
            try {
              const state = await service.open(message.options);
              respond(state);
            } finally {
              stopProgress();
            }
            break;
          }
          case "browser.close":
            await service.closeThread(threadId, {
              kind: "human",
              connectionId: options.connectionId,
            });
            respond(null);
            break;
          case "browser.engine.move": {
            if (!options.engine) throw new Error("Engine moves aren't available on this machine");
            const stopProgress = service.downloadProgress((progress) => {
              if (!closed) options.send(progress);
            });
            try {
              respond(
                await service.moveEngine(
                  {
                    threadId,
                    workspaceId: message.workspaceId,
                    engine: message.engine,
                  },
                  options.engine,
                ),
              );
            } finally {
              stopProgress();
            }
            break;
          }
          case "browser.execute":
            respond(
              await service.execute(threadId, message.command, {
                kind: "human",
                connectionId: options.connectionId,
              }),
            );
            break;
          case "browser.input":
            await service.input(threadId, message.input, options.connectionId, message.tabId);
            respond(null);
            break;
          case "browser.auth.answer":
            respond(
              await service.asPerson(threadId, {
                kind: "auth",
                tabId: message.tabId,
                authId: message.authId,
                credentials: message.credentials,
              }),
            );
            break;
          case "browser.certificate.proceed":
            respond(
              await service.asPerson(threadId, {
                kind: "certificate",
                tabId: message.tabId,
                url: message.url,
              }),
            );
            break;
          case "browser.files.choose": {
            const open = options.attachment;
            if (!open && message.files.length) throw new Error("Picking files is unavailable here");
            respond(
              await service.asPerson(threadId, {
                kind: "files",
                tabId: message.tabId,
                chooserId: message.chooserId,
                files: message.files.map((file) => ({
                  name: file.name,
                  open: () => {
                    if (!open) throw new Error("Picking files is unavailable here");
                    return open(threadId, file.sha256);
                  },
                })),
              }),
            );
            break;
          }
          case "browser.files.drop": {
            const open = options.attachment;
            if (!open) throw new Error("Dropping files is unavailable here");
            respond(
              await service.dropFiles(
                threadId,
                {
                  tabId: message.tabId,
                  x: message.x,
                  y: message.y,
                  modifiers: message.modifiers,
                  files: message.files.map((file) => ({
                    name: file.name,
                    open: () => open(threadId, file.sha256),
                  })),
                },
                options.connectionId,
              ),
            );
            break;
          }
          case "browser.download.read": {
            if (!sendStream) throw new Error("Fetching downloads needs binary messages");
            const read = await service.readDownload(
              threadId,
              message.downloadId,
              message.offset,
              message.length,
              message.validator,
            );
            if (closed) break;
            streamId = (streamId + 1) >>> 0;
            const pieces = encodeDownloadChunk(streamId, {
              threadId: ThreadId.parse(threadId),
              downloadId: message.downloadId,
              offset: message.offset,
              size: read.size,
              bytes: read.bytes,
            });
            // The connection is backed up (frames, other chunks): the client asks again shortly.
            if (!sendStream(pieces)) throw new Error(downloadBusy);
            respond({
              downloadId: message.downloadId,
              offset: message.offset,
              bytes: read.bytes.length,
              size: read.size,
              validator: read.validator,
              done: message.offset + read.bytes.length >= read.size,
            } satisfies BrowserDownloadRead);
            break;
          }
          case "browser.tabs.mute":
            respond(
              await service.asPerson(threadId, {
                kind: "mute",
                tabId: message.tabId,
                muted: message.muted,
              }),
            );
            break;
          case "browser.tabs.private":
            respond(service.setPrivate(threadId, message.tabId, message.private));
            break;
          case "browser.subscribe": {
            const subscriber = message.subscriberId ?? "legacy";
            const existing = subscriptions.get(threadId);
            // Limits first: nothing is granted for a subscribe that is then refused.
            if (existing) {
              if (existing.subscribers.size >= 64 && !existing.subscribers.has(subscriber))
                throw new Error("Browser subscriber limit");
            } else if (subscriptions.size >= 8) throw new Error("Browser subscription limit");
            // Everything this subscribe changes, to put back if any of it fails.
            const before = existing && {
              subscribers: new Set(existing.subscribers),
              media: new Map(existing.media),
              old: new Set(existing.old),
              status: new Set(existing.status),
              views: new Map(existing.views),
              video: existing.video,
              shown: existing.shown,
            };
            // A resubscribe replaces this subscriber's view: it leaves the old one first, so the
            // two never both deliver; the old grant closes once this subscribe has succeeded.
            const left = leave(existing, subscriber);
            let joined: { viewer: string; created: boolean } | undefined;
            const swap = () => {
              const was = before?.media.get(subscriber);
              const connection = message.media?.connection;
              return viewSwap(
                options.media?.delivery(),
                left !== undefined && was !== undefined
                  ? { viewer: left, connection: was }
                  : undefined,
                joined?.created && connection !== undefined
                  ? { viewer: joined.viewer, connection }
                  : undefined,
              );
            };
            try {
              joined = message.media
                ? bindMedia(threadId, message.media.connection, message, existing)
                : undefined;
              const video = message.video;
              // A viewer that says what it shows gets frames sized for it from the first one.
              const capture = message.viewport ? viewer(message.viewport, video) : undefined;
              const join = (entry: Subscription) => {
                if (message.mediaClient === true) entry.old.delete(subscriber);
                else entry.old.add(subscriber);
                if (message.deliveryStatus === true) entry.status.add(subscriber);
                else entry.status.delete(subscriber);
                if (!joined || !message.media) return;
                entry.media.set(subscriber, message.media.connection);
                entry.views.set(message.media.connection, joined.viewer);
              };
              let entry = existing;
              if (entry) {
                entry.video = video;
                join(entry);
                entry.subscribers.add(subscriber);
                const shown = capture && deliveredBy(entry, capture);
                if (capture) entry.shown = capture;
                if (shown) service.configureCapture(threadId, options.connectionId, shown);
                options.send({
                  type: "browser.state",
                  state: forPeer(entry, service.state(threadId)),
                });
              } else {
                entry = {
                  subscribers: new Set([subscriber]),
                  stop() {},
                  video,
                  media: new Map(),
                  old: new Set(),
                  status: new Set(),
                  views: new Map(),
                  shown: capture,
                };
                join(entry);
                const shown = capture && deliveredBy(entry, capture);
                bind(threadId, entry, shown);
                subscriptions.set(threadId, entry);
                if (shown) service.configureCapture(threadId, options.connectionId, shown);
              }
            } catch (error) {
              // Undo it all: the view granted for this subscribe (the old one opens again where
              // the new one replaced it), a subscription it installed, and the thread's
              // subscription as it was, capture settings included.
              swap().abort();
              if (existing && before) {
                Object.assign(existing, before);
                if (before.shown)
                  try {
                    service.configureCapture(
                      threadId,
                      options.connectionId,
                      deliveredBy(existing, before.shown),
                    );
                  } catch {
                    // The capture keeps what it had; the error that matters is the one below.
                  }
              } else {
                const installed = subscriptions.get(threadId);
                if (installed) {
                  installed.stop();
                  subscriptions.delete(threadId);
                }
              }
              throw error;
            }
            swap().commit();
            if (joined && message.media) {
              const poster = await options.media?.delivery()?.poster(joined.viewer);
              if (!closed)
                options.send({
                  type: "browser.result",
                  requestId: message.requestId,
                  ok: true,
                  result: null,
                  media: mediaSubscribed(message.media.connection, poster),
                });
              // Bound, but its tab isn't streaming into ace-media yet: the view says why until
              // the grant comes (`onGrant`).
              if (!options.media?.delivery()?.granted(joined.viewer)) delivered(threadId, false);
              break;
            }
            // No pictures will come: the view says why instead of staying blank.
            if (!closed)
              options.send({
                type: "browser.result",
                requestId: message.requestId,
                ok: true,
                result: null,
                undelivered: browserUndelivered(threadId, message.media !== undefined),
              });
            break;
          }
          case "browser.unsubscribe": {
            const entry = subscriptions.get(threadId);
            const subscriber = message.subscriberId ?? "legacy";
            retire(entry, subscriber);
            entry?.subscribers.delete(subscriber);
            entry?.old.delete(subscriber);
            entry?.status.delete(subscriber);
            // Who is left decides again whether ace-media delivers this view.
            if (entry?.subscribers.size && entry.shown)
              service.configureCapture(
                threadId,
                options.connectionId,
                deliveredBy(entry, entry.shown),
              );
            if (entry && !entry.subscribers.size) {
              entry.stop();
              subscriptions.delete(threadId);
            }
            respond(null);
            break;
          }
          case "browser.capture": {
            const entry = subscriptions.get(threadId);
            if (!entry) throw new Error("Browser viewer is not subscribed");
            const delivery = options.media?.delivery();
            for (const mediaViewer of entry.views.values()) {
              delivery?.configure(
                mediaViewer,
                viewViewport(message.viewport),
                message.viewport.audio === true,
              );
              delivery?.pause(mediaViewer, message.viewport.paused === true);
            }
            entry.shown = viewer(message.viewport, entry.video);
            service.configureCapture(
              threadId,
              options.connectionId,
              deliveredBy(entry, entry.shown),
            );
            respond(null);
            break;
          }
          case "browser.ack":
            // Acks go on the media connection now: the daemon sends no video to ack here.
            break;
          case "browser.recording.start":
            await service.startRecording(threadId, {
              kind: "human",
              connectionId: options.connectionId,
            });
            respond(null);
            break;
          case "browser.recording.stop":
            respond(
              await service.stopRecording(threadId, {
                kind: "human",
                connectionId: options.connectionId,
              }),
            );
            break;
        }
      } catch (error) {
        if (!closed)
          options.send({
            type: "browser.result",
            requestId: message.requestId,
            ok: false,
            ...(error instanceof BrowserOriginError ? { blocked: error.blocked } : {}),
            error: (error instanceof Error ? error.message : "Browser operation failed").slice(
              0,
              2048,
            ),
          });
      } finally {
        if (counted) pending--;
      }
    },
    close() {
      closed = true;
      for (const entry of subscriptions.values()) {
        for (const mediaViewer of entry.views.values())
          options.media?.delivery()?.unbind(mediaViewer);
        entry.stop();
      }
      subscriptions.clear();
      service.disconnect(options.connectionId);
    },
  };
}

function viewer(
  viewport: BrowserCaptureViewport,
  video: BrowserVideoRequest | undefined,
): CaptureViewer {
  return { viewport, ...(video ? { video } : {}) };
}
