import { fileExportSource } from "../file-export-source.ts";
import type { MediaAdmission, MediaOwner } from "@ace/media/media-connections";
import { providerAuthRelay } from "./provider-auth-relay.ts";
import { relayAttachments } from "./relay-attachments.ts";
import { connectBrowser, type BrowserService } from "@ace/browser";
import { screenConnection, Simulators, type ScreenManager } from "@ace/screen";
import { chunkFilesChannel, attachFilesRelay, type FilesService } from "@ace/files";
import { filesScope } from "../files-scope.ts";
import { relayFiles } from "../files-tool/relay-files.ts";
import {
  BrowserClientMessage,
  AgentId,
  ThreadId,
  type ClientMessage,
  type DeviceFailure,
  type DeviceId,
} from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { Store } from "../store.ts";
import { contextScope } from "./context-scope.ts";
import { lazyDevices } from "../lazy-devices.ts";
import { deviceAccessRefused, devicesUnavailable } from "./device-refusals.ts";
/**
 * The daemon services a relay channel may use. The daemon passes an object whose fields read its
 * live service registry: the relay connects during startup, before listener-phase services such
 * as sign-in publish, so a copy taken then would miss them for the daemon's whole life.
 */
export interface RelayServices {
  providerLogin?: import("@ace/accounts").ProviderLoginSessions | undefined;
  accountManagement?: import("../account-management.ts").AccountManagement | undefined;
  files?: FilesService | undefined;
  supportFiles?: FilesService | undefined;
  context?: import("../server-options.ts").ServerOptions["context"] | undefined;
  threadFiles?: import("../files-workspaces.ts").FilesWorkspaces | undefined;
  /** The daemon's ace-files: folder listings, quick open and folder watches (ADR 0178). */
  filesNative?: import("../files-tool/wiring.ts").FilesNative | undefined;
  appDevices?:
    | import("@ace/devices").DevicesService
    | import("../lazy-devices.ts").LazyDevices
    | undefined;
  browser?: BrowserService | undefined;
  screen?: ScreenManager | undefined;
  mediaAcceleration?: import("@ace/media/acceleration").MediaAccelerationStore | undefined;
  store?: Store | undefined;
  canReadThread?: ((device: DeviceId, thread: ThreadId) => boolean) | undefined;
  /** Warn-level daemon log for refused requests. */
  warn?: ((message: string, fields: object) => void) | undefined;
  /** Delivery by ace-media (D1), for subscribes on this channel that name a media connection. */
  mediaDelivery?: import("../server-options.ts").ServerOptions["mediaDelivery"] | undefined;
}
/** A dedicated authenticated relay channel never mixes file packets and media stream pieces. */
export function attachRelayService(
  options: RelayServices,
  connection: {
    channel: HostChannel;
    kind: "files" | "devices" | "browser" | "screen" | "provider_auth";
    device: DeviceId;
    sessionId: string;
    /** How the device was admitted: a channel owns that device's media connections (D1). */
    admission?: MediaAdmission | undefined;
    authorize(scope: "read" | "operate" | "admin"): boolean;
  },
) {
  const { channel, device, authorize, sessionId } = connection;
  // A channel of its own binds views on its device's media connections, admitted the same way.
  const mediaOwner = (): MediaOwner | undefined =>
    connection.admission
      ? { session: sessionId, device, admission: connection.admission }
      : undefined;
  const mediaDelivery = { owner: mediaOwner, port: () => options.mediaDelivery?.() };
  if (connection.kind === "provider_auth")
    return providerAuthRelay({
      channel,
      device,
      authorize,
      login: () => options.providerLogin,
      accounts: () => options.accountManagement,
      ...(options.warn ? { warn: options.warn } : {}),
    });
  const threadAccess = (threadId: string) => {
    const id = ThreadId.parse(threadId);
    return (
      options.store?.hasLiveThread(id) === true && (options.canReadThread?.(device, id) ?? true)
    );
  };
  const send = async (message: Parameters<HostChannel["send"]>[0]) => {
    if (!authorize("admin")) throw new Error("Relay device access revoked");
    if (channel.bufferedBytes > 256 * 1024) {
      channel.close();
      throw new Error("Relay control backpressure");
    }
    await channel.send(message);
  };
  if (connection.kind === "devices") {
    // Answer every request with why, rather than closing the channel without a word: the
    // client would otherwise wait on a device list that never comes.
    if (!options.appDevices || !authorize("admin"))
      return refusingDevicesRelay(
        channel,
        options.appDevices ? deviceAccessRefused : devicesUnavailable,
      );
    // A phone opening its devices channel is someone using devices: load them now.
    const devices = lazyDevices(options.appDevices);
    let closed = false;
    let endpoint: ReturnType<typeof import("@ace/devices").connectDevices> | undefined;
    const ready = (async () => {
      const service = await devices.load();
      const { connectDevices } = await import("@ace/devices");
      if (closed) return undefined;
      endpoint = connectDevices(service, sessionId, {
        authorize: () => authorize("admin"),
        delivery: mediaDelivery,
        acceleration: options.mediaAcceleration,
        canReadThread: threadAccess,
        agentExists: (threadId, agentId) =>
          options.store?.getMcpAgent(ThreadId.parse(threadId), AgentId.parse(agentId)) !==
          undefined,
        send,
        media: {
          bufferedBytes: () => channel.bufferedBytes,
          write: async (piece) => {
            if (!authorize("admin")) throw new Error("Device stream access revoked");
            await channel.sendBinary(piece);
          },
        },
      });
      return endpoint;
    })();
    void ready.catch(() => {});
    return {
      async accept(message: ClientMessage) {
        if (message.type !== "devices.ack" && message.type !== "devices.request")
          throw new Error("Unexpected devices relay request");
        const peer = await ready;
        if (!peer) throw new Error("Devices relay closed");
        if (message.type === "devices.ack") return peer.ack(message);
        return peer.request(message);
      },
      binary() {
        throw new Error("Device relay does not accept input binary data");
      },
      close() {
        closed = true;
        endpoint?.close();
      },
    };
  }
  if (connection.kind === "browser") {
    if (!options.browser) throw new Error("Browser relay unavailable");
    const endpoint = connectBrowser(options.browser, {
      connectionId: sessionId,
      media: { owner: mediaOwner, delivery: () => options.mediaDelivery?.() },
      authorize: (threadId, workspaceId, access) =>
        authorize(access) &&
        threadAccess(threadId) &&
        (workspaceId === undefined ||
          options.store?.getThread(ThreadId.parse(threadId))?.workspaceId === workspaceId),
      send(message) {
        if (channel.bufferedBytes > 256 * 1024) {
          channel.close();
          return false;
        }
        void channel.send(message).catch(() => channel.close());
        return true;
      },
      // Each piece fits one encrypted binary message; a frame waits out a backlog by dropping.
      sendStream(pieces) {
        if (channel.bufferedBytes > 256 * 1024) return false;
        for (const piece of pieces) void channel.sendBinary(piece).catch(() => channel.close());
        return true;
      },
    });
    return {
      accept(message: ClientMessage) {
        return endpoint.handle(BrowserClientMessage.parse(message));
      },
      binary() {
        throw new Error("Browser relay does not accept binary input");
      },
      close: endpoint.close,
    };
  }
  if (connection.kind === "screen") {
    if (!options.screen || !authorize("admin"))
      throw new Error("Screen relay requires admin access");
    const endpoint = screenConnection(options.screen, new Simulators(process.platform), sessionId, {
      delivery: mediaDelivery,
      acceleration: options.mediaAcceleration,
      send(message) {
        void send(message).catch(() => channel.close());
      },
      media: {
        bufferedBytes: () => channel.bufferedBytes,
        write: async (piece) => {
          if (!authorize("admin")) throw new Error("Screen stream access revoked");
          await channel.sendBinary(piece);
        },
      },
      failed: () => channel.close(),
    });
    return {
      accept(message: ClientMessage) {
        if (!authorize("admin")) throw new Error("Screen access denied");
        if (message.type === "screen.ack") return endpoint.ack(message);
        if (message.type !== "screen.request") throw new Error("Screen access denied");
        return endpoint.request(message);
      },
      binary() {
        throw new Error("Screen relay does not accept binary input");
      },
      close: endpoint.close,
    };
  }
  const legacyService = options.files;
  const legacy = legacyService
    ? attachFilesRelay(legacyService, channel, device, (scope, operation) => {
        if (!authorize(scope === "files.read" ? "read" : "operate")) return false;
        const source = fileExportSource(legacyService, options.store, operation);
        return source === undefined || threadAccess(source);
      })
    : undefined;
  const attachments = relayAttachments(options.context, channel, device, authorize, threadAccess);
  /** The same binding the main socket's chunk channel, listings and watches use. */
  const resolve = filesScope({
    authorize,
    threadAccess,
    connected: () => true,
    options: {
      threadFiles: options.threadFiles,
      supportFiles: options.supportFiles,
      filesNative: options.filesNative,
      store: options.store,
    },
  });
  /** Pushes on this channel are bounded like the chunk channel's, never gated on admin. */
  const push = (message: Parameters<HostChannel["send"]>[0]) => {
    if (!authorize("read")) return;
    if (channel.bufferedBytes > 256 * 1024) {
      channel.close();
      return;
    }
    void channel.send(message).catch(() => channel.close());
  };
  const filesChannel = relayFiles({
    clientId: sessionId,
    authorize,
    threadAccess,
    matches: (threadId, root) => options.threadFiles?.matches(threadId, root) ?? false,
    resolve,
    tool: options.filesNative?.tool,
    folders: options.filesNative?.folders,
    push,
    buffered: () => channel.bufferedBytes,
    ...(options.warn ? { warn: options.warn } : {}),
  });
  const chunks =
    options.threadFiles || options.supportFiles
      ? chunkFilesChannel({
          device,
          send: (message) => {
            if (channel.bufferedBytes > 1024 * 1024) {
              channel.close();
              return;
            }
            void channel.send(message).catch(() => channel.close());
          },
          resolve,
        })
      : undefined;
  return {
    async accept(message: ClientMessage) {
      if (filesChannel.accept(message)) return;
      if (attachments?.accept(message)) return;
      if (message.type === "files.request" && message.operation.op === "attachment.download") {
        await channel.send({
          type: "files.error",
          requestId: message.requestId,
          code: "NOT_FOUND",
          message: "Attachment streaming unavailable",
        });
        return;
      }
      if (message.type === "context.request") {
        if (channel.bufferedBytes > 256 * 1024) {
          channel.close();
          throw new Error("Attachment relay backpressure");
        }
        const op = message.operation;
        const scope = contextScope(op);
        const access = (thread?: string) =>
          authorize(scope) &&
          (thread === undefined || threadAccess(thread)) &&
          (!("threadId" in op) || threadAccess(op.threadId));
        if (!options.context || !access()) {
          await channel.send({
            type: "context.result",
            requestId: message.requestId,
            result: {
              kind: "error",
              code: "forbidden",
              message: `Thread attachment ${scope} permission required`,
            },
          });
          return;
        }
        await channel.send(await options.context.handle(device, message, access));
        return;
      }
      if (message.type === "files.request" && message.scope === "support") {
        const op = message.operation;
        if (
          (op.op !== "artifact.support" && op.op !== "artifact.download") ||
          (op.op === "artifact.support" && op.includeThreads) ||
          (op.op === "artifact.download" && op.artifactId.startsWith("local-support-"))
        )
          throw new Error("Conversation export requires local access");
      }
      if (
        message.type === "files.abort" ||
        message.type === "files.pull" ||
        message.type === "files.chunk" ||
        (message.type === "files.request" &&
          (message.threadId || message.workspaceId || message.scope === "support")) ||
        (message.type === "files.cancel" && message.channel > 0x80000000)
      ) {
        if (!chunks) throw new Error("Scoped files unavailable");
        chunks.accept(message);
      } else if (legacy) legacy.accept(message);
      else throw new Error("Thread-scoped file request required");
    },
    binary(frame: Buffer) {
      if (!legacy) throw new Error("Legacy files unavailable");
      legacy.binary(frame);
    },
    close() {
      chunks?.close();
      legacy?.close();
      filesChannel.close();
      void attachments?.close().catch(() => {});
    },
  };
}

/** A devices relay channel this client may not use: each request is answered with the refusal. */
function refusingDevicesRelay(channel: HostChannel, error: DeviceFailure) {
  return {
    async accept(message: ClientMessage) {
      if (message.type === "devices.ack") return;
      if (message.type !== "devices.request") throw new Error("Unexpected devices relay request");
      if (channel.bufferedBytes > 256 * 1024) {
        channel.close();
        throw new Error("Relay control backpressure");
      }
      await channel.send({
        type: "devices.result",
        requestId: message.requestId,
        ok: false,
        error,
      });
    },
    binary() {
      throw new Error("Device relay does not accept input binary data");
    },
    close() {},
  };
}
