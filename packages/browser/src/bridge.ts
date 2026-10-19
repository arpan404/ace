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
import type { CaptureViewer } from "./fanout.ts";
import { downloadBusy, encodeDownloadChunk } from "./stream-download.ts";

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
    local?: boolean;
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
    /**
     * Opens a thread attachment this connection uploaded (the files a person picks for a page's
     * file input). Without it, picking files is refused.
     */
    attachment?: (
      threadId: string,
      sha256: string,
    ) => Promise<{ chunks: AsyncIterable<Uint8Array>; close(): Promise<void> }>;
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
  };
  const subscriptions = new Map<string, Subscription>();
  const sendStream = options.sendStream;
  const bind = (threadId: string, entry: Subscription, capture?: CaptureViewer) => {
    entry.stop = service.subscribe(
      threadId,
      options.connectionId,
      {
        send: (frame) =>
          entry.binary && sendStream
            ? sendStream(service.streamFrame(threadId, frame))
            : options.send(
                { type: "browser.frame", threadId: ThreadId.parse(threadId), frame },
                service.serializeFrame(threadId, frame),
              ),
        ...(sendStream
          ? {
              video: {
                send: (chunk) =>
                  entry.binary && entry.video !== undefined
                    ? sendStream(service.streamVideo(threadId, chunk))
                    : false,
              },
            }
          : {}),
      },
      (state) => options.send({ type: "browser.state", state }),
      (event) => options.send(event),
      capture,
    );
  };
  const viewer = (
    viewport: BrowserCaptureViewport,
    video: BrowserVideoRequest | undefined,
  ): CaptureViewer => ({
    viewport,
    local: options.local ?? false,
    ...(video ? { video } : {}),
  });
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
            message.type === "browser.open" ? message.options.workspaceId : undefined,
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
            // The newest subscriber's build decides how frames travel on this connection.
            const binary = message.binaryFrames === true && sendStream !== undefined;
            // Video travels only as binary stream messages.
            const video = binary ? message.video : undefined;
            // A viewer that says what it shows gets frames sized for it from the first one.
            const capture = message.viewport ? viewer(message.viewport, video) : undefined;
            let entry = subscriptions.get(threadId);
            if (entry) {
              if (entry.subscribers.size >= 64 && !entry.subscribers.has(subscriber))
                throw new Error("Browser subscriber limit");
              entry.binary = binary;
              entry.video = video;
              if (capture) service.configureCapture(threadId, options.connectionId, capture);
              options.send({ type: "browser.state", state: service.state(threadId) });
              service.replayFrame(threadId, options.connectionId);
              entry.subscribers.add(subscriber);
            } else {
              if (subscriptions.size >= 8) throw new Error("Browser subscription limit");
              entry = { subscribers: new Set([subscriber]), stop() {}, binary, video };
              bind(threadId, entry, capture);
              subscriptions.set(threadId, entry);
              if (capture) service.configureCapture(threadId, options.connectionId, capture);
            }
            respond(null);
            break;
          }
          case "browser.unsubscribe": {
            const entry = subscriptions.get(threadId);
            entry?.subscribers.delete(message.subscriberId ?? "legacy");
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
            service.configureCapture(
              threadId,
              options.connectionId,
              viewer(message.viewport, entry.video),
            );
            respond(null);
            break;
          }
          case "browser.ack":
            if (message.video)
              service.acknowledgeVideo(
                threadId,
                options.connectionId,
                message.sequence,
                message.keyframe === true,
              );
            else service.acknowledge(threadId, options.connectionId, message.sequence);
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
      for (const entry of subscriptions.values()) entry.stop();
      subscriptions.clear();
      service.disconnect(options.connectionId);
    },
  };
}
