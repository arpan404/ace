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
import type { SuitClientMessage, SuitReportMessage, SuitServerMessage } from "@ace/protocol/suits";
import type { MarketClientMessage, MarketServerMessage } from "@ace/protocol/marketplace";
import type { MainSocket } from "../main-socket.ts";
import type { ServerOptions } from "../server-options.ts";
import type { MaintenanceGate } from "@ace/service";
export type SocketMessage =
  | ClientMessage
  | PluginClientMessage
  | SuitClientMessage
  | SuitReportMessage
  | MarketClientMessage
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
  /** The welcome has been sent: the client now accepts this service's pushes. */
  welcomed?(): void;
  handle?(message: SocketMessage, device: DeviceId): boolean | Promise<boolean>;
  command?: CommandRegistration;
  close?(): void;
  /**
   * The device's access was revoked: called just before the socket's cleanup and close, while
   * it is still open, so a session can say why first.
   */
  revoked?(): void;
  healthPending?(): number;
}
export interface SocketContext {
  options: ServerOptions;
  socket: MainSocket;
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
  /** This machine's remote updates (ADR 0113), when the daemon has them. */
  machineUpdates?: import("../machine-update/machine-updates.ts").MachineUpdates;
  device(): DeviceId | undefined;
  /**
   * The generation of the paired credential that authenticated this socket; undefined for the
   * host and account devices, whose authority no credential replacement ends.
   */
  credentialGeneration?(): string | undefined;
  authorize(scope: DeviceScope): boolean;
  /** Capture authenticated authority for admitted durable effects across reconnects. */
  authorityLease?(scope: DeviceScope): () => boolean;
  canReadThread(thread: import("@ace/protocol").ThreadId): boolean;
  /**
   * True while this socket is authenticated by the daemon's own token file credential (loopback
   * only, never revocable), not by a paired device.
   */
  hostCredential?(): boolean;
  /**
   * Whether this socket's credential is the person's for person-only actions (ADR 0178 §12.7,
   * ADR 0190): a paired device, or an account device whose standing grant says person. Not the
   * host token, which any process that reads it holds, and not an account device with only a
   * machine's standing. Absent counts as not.
   */
  personProven?(): boolean;
  /**
   * On an organization's host (ADR 0206 §2.2): the member this socket proved, with their role,
   * while that standing lasts; undefined otherwise.
   */
  memberStanding?(): { org: string; role: string; account: string } | undefined;
  /** Whether this machine is an organization's host (ADR 0206 §2.1). */
  orgHost?(): boolean;
  /**
   * Spade's own access check (`spade.*`): a member who reaches only Spade may read and change it
   * there; every other socket as `authorize` says.
   */
  spadeAuthorize?(scope: DeviceScope): boolean;
  /** The ace account an account device's grant names (ADR 0111); undefined for others. */
  accountDevice?(): string | undefined;
  /** Pairing and paired devices on this daemon (`fleet.request`). */
  access?: {
    auth: import("../remote-auth.ts").RemoteAuth;
    pairing(): import("../pairing-issue.ts").PairingConnection | undefined;
    /** Origin of the web app new pairing links open; this daemon's own when undefined. */
    pairingApp?(): Promise<string | undefined>;
    /** What `GET /v1/status` reports as `remoteAccess`: one implementation for both. */
    remoteStatus?(): import("@ace/protocol").RemoteAccessStatus;
  };
  connected(): boolean;
  send(
    message: ServerMessage | PluginServerMessage | SuitServerMessage | MarketServerMessage,
  ): void;
  fail(
    code: string,
    message: string,
    close?: boolean,
    scope?: { requestId?: string; subscriptionId?: string },
  ): void;
}
