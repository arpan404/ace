import type {
  DeviceId,
  DeviceScope,
  Command,
  CommandResult,
  ClientMessage,
  BrowserClientMessage,
  BrowserBackendClientMessage,
  ServerMessage,
  UserBrowserExtensionMessage,
} from "@ace/protocol";
import type { PluginClientMessage, PluginServerMessage } from "@ace/protocol/plugins";
import type { WebSocket } from "ws";
import type { ServerOptions } from "../server-options.ts";
import type { MaintenanceGate } from "@ace/service";
export type SocketMessage =
  | ClientMessage
  | PluginClientMessage
  | BrowserClientMessage
  | BrowserBackendClientMessage
  | UserBrowserExtensionMessage;
export interface CommandRegistration {
  types: readonly Command["payload"]["type"][];
  scope(command: Command): DeviceScope;
  accept(command: Command, device: DeviceId): void | Promise<void>;
  /**
   * The receipt for a command refused before it is accepted (scope, device, maintenance), for
   * commands whose receipts carry their own codes and words; omitted: the generic error.
   */
  refused?(command: Command, code: string): CommandResult;
}
export interface SocketService {
  binary?(frame: Buffer): boolean;
  /** Runs before welcome; a rejection with code "limit" refuses the socket as over capacity. */
  authenticated?(
    channel: Extract<ClientMessage, { type: "hello" }>["channel"],
  ): void | Promise<void>;
  handle?(message: SocketMessage, device: DeviceId): boolean | Promise<boolean>;
  command?: CommandRegistration;
  close?(): void;
  healthPending?(): number;
}
export interface SocketContext {
  options: ServerOptions;
  socket: WebSocket;
  sessionId: string;
  /** True only for the daemon loopback listener, never a client claim. */
  local?: boolean;
  /** Host token on loopback only. Paired credentials need the encrypted relay. */
  canSubmitSecret?(): boolean;
  /** A presence update was admitted; `appState` says whether a phone app is in the background. */
  onPresence(update: Extract<ClientMessage, { type: "presence.update" }>): void;
  subscriptions: Map<string, () => void>;
  tasks: Set<Promise<void>>;
  maintenance: MaintenanceGate;
  /** The desktop app's last update report (`app-update-board.ts`). */
  appUpdate: import("../app-update-board.ts").AppUpdateBoard;
  device(): DeviceId | undefined;
  authorize(scope: DeviceScope): boolean;
  /** Capture authenticated authority for admitted durable effects across reconnects. */
  authorityLease?(scope: DeviceScope): () => boolean;
  canReadThread(thread: import("@ace/protocol").ThreadId): boolean;
  /**
   * True while this socket is authenticated by the daemon's own token file credential (loopback
   * only, never revocable), not by a paired device.
   */
  hostCredential?(): boolean;
  /** Pairing and paired devices on this daemon (`fleet.request`). */
  access?: {
    auth: import("../remote-auth.ts").RemoteAuth;
    pairing(): import("../pairing-issue.ts").PairingConnection | undefined;
    /** Origin of the web app new pairing links open; this daemon's own when undefined. */
    pairingApp?(): Promise<string | undefined>;
  };
  connected(): boolean;
  send(message: ServerMessage | PluginServerMessage): void;
  fail(
    code: string,
    message: string,
    close?: boolean,
    scope?: { requestId?: string; subscriptionId?: string },
  ): void;
}
