import { connectDevices, sendDeviceFrame, type DevicesService } from "@ace/devices";
import { connectBrowser, type BrowserService } from "@ace/browser";
import { screenConnection, Simulators, type ScreenManager } from "@ace/screen";
import { attachFilesRelay, type FilesService } from "@ace/files";
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
  files: FilesService;
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
  return attachFilesRelay(options.files, channel, device, (scope) =>
    authorize(scope === "files.read" ? "read" : "operate"),
  );
}
