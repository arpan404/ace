import { BrowserOriginError } from "./policy.ts";
import {
  ThreadId,
  BrowserClientMessage,
  type BrowserCaptureViewport,
  type BrowserVideoRequest,
  type BrowserDownloadRead,
  type BrowserServerMessage,
  type DeviceScope,
} from "@ace/protocol";
import type { BrowserService } from "./service.ts";
import type { EnginePreferencePort } from "./engine-move.ts";
import type { CaptureViewer } from "./viewer-sink.ts";
import { downloadBusy, encodeDownloadChunk } from "./stream-download.ts";
import {
  mediaSubscribed,
  viewLink,
  viewSwap,
  viewViewport,
  type MediaDeliveryPort,
} from "@ace/media/media-viewers";
import type { MediaOwner } from "@ace/media/media-connections";

type BrowserAccess = Extract<DeviceScope, "read" | "operate">;

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
     * Sends one frame's binary stream messages (`@ace/browser/stream`), all of them or none;
     * false is backpressure. Without it, every viewer gets frames as JSON.
     */
    sendStream?: (pieces: readonly Uint8Array[]) => boolean;
    /** The connection is on this machine (the daemon's loopback listener, never a client claim). */
    local?: boolean;
    /**
     * Delivery by ace-media (D1) for subscribes that name a media connection, with who this
     * connection is: its session, device and admission (a main session, or a channel of its
     * own). Without it, or while ace-media doesn't serve, a subscribe is served here.
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
  /**
   * `binary`: this connection's viewers of the thread take frames as binary stream messages;
   * `video`: and encoded video in these codecs (ADR 0088).
   */
  type Subscription = {
    stop(): void;
    subscribers: Set<string>;
    binary: boolean;
    video?: BrowserVideoRequest | undefined;
    /**
     * Each subscriber ace-media delivers to, with the media connection it named. The capture
     * still runs here, so the producer streams; while every subscriber is delivered by ace-media,
     * nothing goes on this socket.
     */
    media: Map<string, string>;
    /**
     * The one view ace-media holds per media connection for this thread: a client can't tell two
     * views of one thread apart, so its subscribers there share it (fanned out client-side).
     */
    views: Map<string, string>;
    /** The view the capture was last told about, to tell it again when delivery changes. */
    shown?: CaptureViewer | undefined;
  };
  /** Every subscriber of the entry is delivered by ace-media: nothing goes on this socket. */
  const allMedia = (entry: Subscription) =>
    entry.media.size > 0 && entry.media.size >= entry.subscribers.size;
  /**
   * This connection's view as the daemon's capture sees it: delivered by ace-media while every
   * subscriber is, so the capture runs ace-media's plan for it and the daemon sends it nothing.
   */
  const deliveredBy = (entry: Subscription, capture: CaptureViewer): CaptureViewer =>
    allMedia(entry) ? { ...capture, delivered: true } : capture;
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
  const subscriptions = new Map<string, Subscription>();
  const sendStream = options.sendStream;
  const bind = (threadId: string, entry: Subscription, capture?: CaptureViewer) => {
    entry.stop = service.subscribe(
      threadId,
      options.connectionId,
      sendStream
        ? {
            video: {
              send: (chunk) => {
                if (allMedia(entry)) {
                  queueMicrotask(() =>
                    service.acknowledgeVideo(threadId, options.connectionId, chunk.sequence, false),
                  );
                  return true;
                }
                return entry.binary && entry.video !== undefined
                  ? sendStream(service.streamVideo(threadId, chunk))
                  : false;
              },
            },
            audio: {
              send: (chunk) =>
                allMedia(entry)
                  ? true
                  : entry.binary && entry.video !== undefined
                    ? sendStream(service.streamAudio(threadId, chunk))
                    : false,
            },
            ...(options.local === true ? { local: true } : {}),
          }
        : {},
      (state) => options.send({ type: "browser.state", state }),
      (event) => options.send(event),
      capture,
    );
  };
  /**
   * A subscribe naming a media connection: its viewer on that connection, when ace-media
   * delivers this browser's video now. A connection of another session is refused; otherwise,
   * while ace-media doesn't serve, the subscribe is served on this socket.
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
    const kinds = ["tab", "embedded", "tab-pictures", "user-tab"] as const;
    if (!owner || !delivery || !kinds.some((kind) => delivery.serves(kind))) return undefined;
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
      shows: (producer) => producer.threadId === threadId,
    });
    if (bound === undefined)
      throw new Error("media-connection: that media connection isn't this session's");
    return { viewer: bound, created: true };
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
              views: new Map(existing.views),
              binary: existing.binary,
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
              // The newest subscriber's build decides how frames travel on this connection.
              const binary = message.binaryFrames === true && sendStream !== undefined;
              // Video travels only as binary stream messages.
              const video = binary ? message.video : undefined;
              // A viewer that says what it shows gets frames sized for it from the first one.
              const capture = message.viewport ? viewer(message.viewport, video) : undefined;
              const join = (entry: Subscription) => {
                if (!joined || !message.media) return;
                entry.media.set(subscriber, message.media.connection);
                entry.views.set(message.media.connection, joined.viewer);
              };
              let entry = existing;
              if (entry) {
                entry.binary = binary;
                entry.video = video;
                join(entry);
                entry.subscribers.add(subscriber);
                const shown = capture && deliveredBy(entry, capture);
                if (capture) entry.shown = capture;
                if (shown) service.configureCapture(threadId, options.connectionId, shown);
                options.send({ type: "browser.state", state: service.state(threadId) });
                service.replayFrame(threadId, options.connectionId);
              } else {
                entry = {
                  subscribers: new Set([subscriber]),
                  stop() {},
                  binary,
                  video,
                  media: new Map(),
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
              break;
            }
            respond(null);
            break;
          }
          case "browser.unsubscribe": {
            const entry = subscriptions.get(threadId);
            const subscriber = message.subscriberId ?? "legacy";
            retire(entry, subscriber);
            entry?.subscribers.delete(subscriber);
            // Who is left decides again whether the daemon or ace-media delivers this view.
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
            // Live views are video only: an ack without `video` names nothing the daemon sent.
            if (message.video)
              service.acknowledgeVideo(
                threadId,
                options.connectionId,
                message.sequence,
                message.keyframe === true,
              );
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
