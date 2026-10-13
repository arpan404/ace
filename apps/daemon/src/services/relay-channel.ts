import { fileExportSource } from "../file-export-source.ts";
import { remoteOutputRead } from "../agent-control/remote-return.ts";
import { remoteContextTransfer } from "../agent-control/remote-context-transfer.ts";
import { providerAuthRelay } from "./provider-auth-relay.ts";
import {
  connectDevices,
  sendDeviceFrame,
  devicePacketDelivery,
  type DevicesService,
} from "@ace/devices";
import { connectBrowser, type BrowserService } from "@ace/browser";
import { screenConnection, Simulators, type ScreenManager } from "@ace/screen";
import {
  FileError,
  chunkFilesChannel,
  attachFilesRelay,
  attachmentChannel,
  type FilesService,
} from "@ace/files";
import {
  BrowserClientMessage,
  AgentId,
  ThreadId,
  type ClientMessage,
  type DeviceId,
} from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { Store } from "../store.ts";
import { contextScope } from "./context-scope.ts";
/**
 * The daemon services a relay channel may use. The daemon passes an object whose fields read its
 * live service registry: the relay connects during startup, before listener-phase services such
 * as sign-in publish, so a copy taken then would miss them for the daemon's whole life.
 */
export interface RelayServices {
  remoteDelegation?: import("../server-options.ts").ServerOptions | undefined;
  providerLogin?: import("@ace/accounts").ProviderLoginSessions | undefined;
  accountManagement?: import("../account-management.ts").AccountManagement | undefined;
  files?: FilesService | undefined;
  supportFiles?: FilesService | undefined;
  context?: import("../server-options.ts").ServerOptions["context"] | undefined;
  threadFiles?: import("../files-workspaces.ts").FilesWorkspaces | undefined;
  appDevices?: DevicesService | undefined;
  browser?: BrowserService | undefined;
  screen?: ScreenManager | undefined;
  store?: Store | undefined;
  canReadThread?: ((device: DeviceId, thread: ThreadId) => boolean) | undefined;
  /** Warn-level daemon log for refused requests. */
  warn?: ((message: string, fields: object) => void) | undefined;
}
/** A dedicated authenticated relay channel never mixes file packets and screen packets. */
export function attachRelayService(
  options: RelayServices,
  connection: {
    channel: HostChannel;
    kind: "files" | "devices" | "browser" | "screen" | "provider_auth";
    device: DeviceId;
    sessionId: string;
    authorize(scope: "read" | "operate" | "admin"): boolean;
  },
) {
  const { channel, device, authorize, sessionId } = connection;
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
  if (connection.kind === "browser") {
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
  if (connection.kind === "screen") {
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
  const legacyService = options.files;
  const legacy = legacyService
    ? attachFilesRelay(legacyService, channel, device, (scope, operation) => {
        if (!authorize(scope === "files.read" ? "read" : "operate")) return false;
        const source = fileExportSource(legacyService, options.store, operation);
        return source === undefined || threadAccess(source);
      })
    : undefined;
  const attachmentService = options.context;
  const attachments = attachmentService?.downloadAttachment
    ? attachmentChannel({
        async resolve(thread, hash, maxBytes) {
          const authorized = () => authorize("read") && threadAccess(thread);
          if (!authorized() || !attachmentService.downloadAttachment)
            throw new Error("Thread attachment unavailable");
          const download = await attachmentService.downloadAttachment(
            device,
            thread,
            hash,
            maxBytes,
            authorized,
          );
          return { download, authorized };
        },
        async send(message) {
          if (channel.bufferedBytes > 256 * 1024) throw new Error("Attachment relay backpressure");
          await channel.send(message);
        },
        async binary(bytes) {
          if (channel.bufferedBytes > 256 * 1024) throw new Error("Attachment relay backpressure");
          await channel.sendBinary(bytes);
        },
      })
    : undefined;
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
          async resolve(threadId, scope, operation) {
            if (scope === "support" && options.supportFiles)
              return {
                service: options.supportFiles,
                allowed: (access) => authorize(access),
              };
            const files = options.threadFiles;
            if (!threadId || !files || !threadAccess(threadId))
              throw new Error("File thread unavailable");
            if (
              operation?.op === "artifact.download" &&
              operation.artifactId.startsWith("browser-")
            ) {
              const artifacts = files.browserArtifacts;
              if (!artifacts.owns(threadId, operation.artifactId))
                throw new Error("Artifact is not readable by this thread");
              return {
                service: await artifacts.get(),
                allowed: (access) =>
                  access === "read" &&
                  authorize("read") &&
                  threadAccess(threadId) &&
                  artifacts.owns(threadId, operation.artifactId),
              };
            }
            const root = files.root(threadId);
            const { service, release } = await files.acquire(threadId);
            let source: ThreadId | undefined;
            try {
              source = fileExportSource(service, options.store, operation);
              if (source !== undefined && (source !== threadId || !threadAccess(source)))
                throw new FileError("FORBIDDEN", "Export source is not readable by this thread");
            } catch (error) {
              release();
              throw error;
            }
            return {
              service,
              release,
              allowed: (access) =>
                authorize(access) &&
                threadAccess(threadId) &&
                files.matches(threadId, root) &&
                (source === undefined || threadAccess(source)),
            };
          },
        })
      : undefined;
  return {
    async accept(message: ClientMessage) {
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
      if (message.type === "delegation.remote.output") {
        if (!options.remoteDelegation) throw new Error("Remote output unavailable");
        await channel.send(
          await remoteOutputRead(
            options.remoteDelegation,
            message,
            (thread) => authorize("read") && (!thread || threadAccess(thread)),
          ),
        );
        return;
      }
      if (message.type === "delegation.remote.context") {
        if (!options.remoteDelegation) throw new Error("Remote task context unavailable");
        const scope = message.operation.op === "read" ? "read" : "operate";
        await channel.send(
          await remoteContextTransfer(
            options.remoteDelegation,
            message,
            (thread) => authorize(scope) && (!thread || threadAccess(thread)),
          ),
        );
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
        (message.type === "files.request" && (message.threadId || message.scope === "support")) ||
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
      void attachments?.close().catch(() => {});
    },
  };
}
