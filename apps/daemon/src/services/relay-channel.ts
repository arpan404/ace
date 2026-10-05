import {
  connectDevices,
  sendDeviceFrame,
  devicePacketDelivery,
  type DevicesService,
} from "@ace/devices";
import { connectBrowser, type BrowserService } from "@ace/browser";
import { screenConnection, Simulators, type ScreenManager } from "@ace/screen";
import { chunkFilesChannel, attachFilesRelay, type FilesService } from "@ace/files";
import {
  BrowserClientMessage,
  AgentId,
  ThreadId,
  type ClientMessage,
  type DeviceId,
} from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { Store } from "../store.ts";
export interface RelayServices {
  files?: FilesService;
  context?: import("../server-options.ts").ServerOptions["context"];
  threadFiles?: import("../files-workspaces.ts").FilesWorkspaces;
  appDevices?: DevicesService;
  browser?: BrowserService;
  screen?: ScreenManager;
  store?: Store;
  canReadThread?: (device: DeviceId, thread: ThreadId) => boolean;
}
/** A dedicated authenticated relay channel never mixes file packets and screen packets. */
export function attachRelayService(
  options: RelayServices & {
    channel: HostChannel;
    kind: "files" | "devices" | "browser" | "screen";
    device: DeviceId;
    sessionId: string;
    authorize(scope: "read" | "operate" | "admin"): boolean;
  },
) {
  const { channel, device, authorize, sessionId } = options;
  const threadAccess = (threadId: string) => {
    const id = ThreadId.parse(threadId);
    return (
      options.store?.getThread(id) !== undefined && (options.canReadThread?.(device, id) ?? true)
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
  if (options.kind === "devices") {
    if (!options.appDevices || !authorize("admin"))
      throw new Error("Devices relay requires admin access");
    const endpoint = connectDevices(options.appDevices, sessionId, {
      authorize: () => authorize("admin"),
      canReadThread: threadAccess,
      agentExists: (threadId, agentId) =>
        options.store?.getMcpAgent(ThreadId.parse(threadId), AgentId.parse(agentId)) !== undefined,
      send,
      ...devicePacketDelivery({
        bufferedBytes: () => channel.bufferedBytes,
        authorize: () => authorize("admin"),
        write: (packet) =>
          sendDeviceFrame(
            packet,
            (chunk) => channel.sendBinary(chunk),
            () => authorize("admin"),
          ).catch((error: unknown) => {
            channel.close();
            throw error;
          }),
      }),
    });
    return {
      accept(message: ClientMessage) {
        if (message.type !== "devices.request") throw new Error("Unexpected devices relay request");
        return endpoint.request(message);
      },
      binary() {
        throw new Error("Device relay does not accept input binary data");
      },
      close: endpoint.close,
    };
  }
  if (options.kind === "browser") {
    if (!options.browser) throw new Error("Browser relay unavailable");
    const endpoint = connectBrowser(options.browser, {
      connectionId: sessionId,
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
  if (options.kind === "screen") {
    if (!options.screen || !authorize("admin"))
      throw new Error("Screen relay requires admin access");
    const endpoint = screenConnection(options.screen, new Simulators(process.platform), sessionId, {
      send(message) {
        void send(message).catch(() => channel.close());
      },
      frame: (packet) =>
        sendDeviceFrame(
          packet,
          (chunk) => channel.sendBinary(chunk),
          () => authorize("admin"),
        ).catch((error: unknown) => {
          channel.close();
          throw error;
        }),
    });
    return {
      accept(message: ClientMessage) {
        if (!authorize("admin") || message.type !== "screen.request")
          throw new Error("Screen access denied");
        return endpoint.request(message);
      },
      binary() {
        throw new Error("Screen relay does not accept binary input");
      },
      close: endpoint.close,
    };
  }
  const legacy = options.files
    ? attachFilesRelay(options.files, channel, device, (scope) =>
        authorize(scope === "files.read" ? "read" : "operate"),
      )
    : undefined;
  const chunks = options.threadFiles
    ? chunkFilesChannel({
        device,
        send: (message) => {
          if (channel.bufferedBytes > 1024 * 1024) {
            channel.close();
            return;
          }
          void channel.send(message).catch(() => channel.close());
        },
        async resolve(threadId) {
          const files = options.threadFiles;
          if (!files || !threadAccess(threadId)) throw new Error("File thread unavailable");
          const root = files.root(threadId);
          const service = await files.get(threadId);
          return {
            service,
            allowed: (access) =>
              authorize(access) && threadAccess(threadId) && files.matches(threadId, root),
          };
        },
      })
    : undefined;
  return {
    async accept(message: ClientMessage) {
      if (message.type === "context.request") {
        if (channel.bufferedBytes > 256 * 1024) {
          channel.close();
          throw new Error("Attachment relay backpressure");
        }
        const op = message.operation;
        if (
          !options.context ||
          op.op !== "attachment.read" ||
          !authorize("read") ||
          !threadAccess(op.threadId)
        ) {
          await channel.send({
            type: "context.result",
            requestId: message.requestId,
            result: {
              kind: "error",
              code: "forbidden",
              message: "Thread attachment read permission required",
            },
          });
          return;
        }
        await channel.send(
          await options.context.handle(
            device,
            message,
            () => authorize("read") && threadAccess(op.threadId),
          ),
        );
        return;
      }
      if (
        message.type === "files.abort" ||
        message.type === "files.pull" ||
        message.type === "files.chunk" ||
        (message.type === "files.request" && message.threadId) ||
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
    },
  };
}
