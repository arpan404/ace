import { z } from "zod";
import {
  ClientMessage,
  BrowserClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
} from "@ace/protocol";
import { PluginClientMessage } from "@ace/protocol/plugins";
import type { SocketMessage } from "./socket.ts";

export function parseSocketMessage(input: unknown): SocketMessage {
  for (const schema of [
    ClientMessage,
    PluginClientMessage,
    BrowserClientMessage,
    BrowserBackendClientMessage,
    UserBrowserExtensionMessage,
  ]) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  }
  throw new Error("Message does not match the protocol");
}

/** A frame from a signed-in device: a message, a request this daemon doesn't know, or junk. */
export type DeviceFrame =
  | { kind: "message"; message: SocketMessage }
  | { kind: "unsupported"; requestId?: string }
  | { kind: "invalid" };

export function decodeDeviceFrame(value: unknown): DeviceFrame {
  const requestShape = z
    .object({ type: z.string(), requestId: z.string().optional() })
    .safeParse(value);
  try {
    return { kind: "message", message: parseSocketMessage(value) };
  } catch {
    if (!requestShape.success) return { kind: "invalid" };
    return requestShape.data.requestId
      ? { kind: "unsupported", requestId: requestShape.data.requestId }
      : { kind: "unsupported" };
  }
}
