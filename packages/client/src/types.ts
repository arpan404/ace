import type { Credential } from "./credentials.ts";
import type { DeviceId, HostId } from "@ace/protocol";

export interface TransportEvents {
  open(): void;
  message(text: string): void;
  binary?(bytes: Uint8Array): void;
  /** The socket closed, with its close code and the peer's reason when it gave one. */
  close(code: number, reason?: string): void;
}
export interface Transport {
  readonly supportsBinary?: boolean;
  open(events: TransportEvents): void;
  send(text: string): void;
  close(): void;
}
export interface IntentRecords {
  load(): Promise<readonly string[]>;
  write(id: string, value: string | null): Promise<void>;
}
export interface Storage {
  /** Authenticated daemon identity, persisted separately from receipt-trimmed intents. */
  hostBinding?: { load(): Promise<string | null>; save(hostId: string): Promise<void> };
  /** Record-level persistence. Legacy load/save remain supported for portable hosts. */
  records?: IntentRecords;
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}
export interface Scheduler {
  set(delayMs: number, callback: () => void): () => void;
}
export type ConnectionState =
  | "connecting"
  | "starting"
  | "ready"
  | "reconnecting"
  | "offline"
  | "fatal";
/** The connection's state and retry schedule, for "retrying in 12s · Retry now". */
export interface ConnectionInfo {
  state: ConnectionState;
  /** Failed attempts since the connection was last healthy; reconnect backoff grows with it. */
  attempt: number;
  /** When the scheduled reconnect runs; absent unless one is waiting (and without `now`). */
  nextRetryAt?: number;
  /** When the current state began. */
  since?: number;
  /** When the connection last became ready. */
  lastReadyAt?: number;
  /** Why the last connection ended, for diagnostics; absent until one has. */
  lastClose?: ConnectionClose;
}
/**
 * How a connection ended: the socket's close code and reason, or the client's own (1006 for a
 * missed heartbeat or handshake, 1002 for a server frame it couldn't read).
 */
export interface ConnectionClose {
  code: number;
  reason: string;
  /** When it closed; absent without `now`. */
  at?: number;
}
export interface ClientOptions {
  deviceId: DeviceId;
  /** Pin a directory entry before subscriptions or durable intents can replay. */
  expectedHostId?: HostId;
  transport(): Transport;
  /**
   * Optional owning-host source (for example, its encrypted relay). Honor cancellation and
   * emit validated metadata then owned chunks of at most 64 KiB, with exact size/hash EOF.
   */
  attachmentSource?(
    input: import("./attachment-types.ts").AttachmentInput & { maxBytes: number },
    options: RequestOptions,
  ): AsyncGenerator<import("./attachment-types.ts").AttachmentFrame>;
  credential(): Promise<Credential>;
  storage: Storage;
  scheduler: Scheduler;
  random(): number;
  id(): string;
  /** Wall-clock milliseconds for `connectionInfo()` timestamps; without it they are left out. */
  now?(): number;
  limits?: Partial<Limits>;
}
export interface Limits {
  intents: number;
  threads: number;
  requests: number;
  frameBytes: number;
  /** Aggregate retained UTF-16 bytes across fragment assemblies. */
  fragmentBytes: number;
  /** Absolute lifetime from the first fragment, not extended by later fragments. */
  fragmentMs: number;
  sendBytes: number;
  outboxBytes: number;
  items: number;
  entities: number;
  text: number;
  listeners: number;
  requestMs: number;
  /** Cold startup may outlive an ordinary read; never extend this deadline on progress. */
  handshakeMs: number;
  heartbeatMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  /**
   * How long a connection must stay up before reconnect backoff starts over. A daemon that
   * accepts and then drops at once keeps backing off instead of being retried at the base delay.
   */
  healthyMs: number;
  /**
   * How long a durable command sent on a live connection may go without a receipt before the
   * client asks the daemon whether it still has it (`command.status`), and again while it runs.
   */
  commandStatusMs: number;
}
export const defaultLimits: Limits = {
  intents: 256,
  threads: 32,
  requests: 256,
  frameBytes: 2 * 1024 * 1024,
  fragmentBytes: 64 * 1024 * 1024,
  fragmentMs: 30000,
  sendBytes: 1024 * 1024,
  outboxBytes: 8 * 1024 * 1024,
  items: 200,
  entities: 4096,
  text: 65536,
  listeners: 4096,
  requestMs: 15000,
  handshakeMs: 120_000,
  heartbeatMs: 15000,
  retryBaseMs: 250,
  retryCapMs: 30000,
  healthyMs: 30000,
  commandStatusMs: 60_000,
};
export { ClientError } from "./errors.ts";
export interface RequestOptions {
  /** Optional service correlation selected by the caller, also carried by progress events. */
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TextReadOptions extends RequestOptions {
  /** UTF-16LE byte offset of an already displayed prefix (an even number). */
  offset?: number;
}
