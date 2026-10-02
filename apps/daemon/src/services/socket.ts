import type {
  DeviceId,
  DeviceScope,
  Command,
  ClientMessage,
  BrowserClientMessage,
  ServerMessage,
} from "@ace/protocol";
import type { PluginClientMessage, PluginServerMessage } from "@ace/protocol/plugins";
import type { WebSocket } from "ws";
import type { ServerOptions } from "../server-options.ts";
import type { MaintenanceGate } from "@ace/service";
export type SocketMessage = ClientMessage | PluginClientMessage | BrowserClientMessage;
export interface CommandRegistration {
  types: readonly Command["payload"]["type"][];
  scope(command: Command): DeviceScope;
  accept(command: Command, device: DeviceId): void | Promise<void>;
}
export interface SocketService {
  handle?(message: SocketMessage, device: DeviceId): boolean | Promise<boolean>;
  command?: CommandRegistration;
  close?(): void;
  healthPending?(): number;
}
export interface SocketContext {
  options: ServerOptions;
  socket: WebSocket;
  sessionId: string;
  subscriptions: Map<string, () => void>;
  tasks: Set<Promise<void>>;
  maintenance: MaintenanceGate;
  device(): DeviceId | undefined;
  authorize(scope: DeviceScope): boolean;
  canReadThread(thread: import("@ace/protocol").ThreadId): boolean;
  connected(): boolean;
  send(message: ServerMessage | PluginServerMessage): void;
  fail(
    code: string,
    message: string,
    close?: boolean,
    scope?: { requestId?: string; subscriptionId?: string },
  ): void;
}
