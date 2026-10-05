import type { Credential } from "./credentials.ts";
import type { DeviceId, HostId } from "@ace/protocol";

export interface TransportEvents {
  open(): void;
  message(text: string): void;
  close(code: number): void;
}
export interface Transport {
  open(events: TransportEvents): void;
  send(text: string): void;
  close(): void;
}
export interface IntentRecords {
  load(): Promise<readonly string[]>;
  write(id: string, value: string | null): Promise<void>;
}
export interface Storage {
  /** Record-level persistence. Legacy load/save remain supported for portable hosts. */
  records?: IntentRecords;
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}
export interface Scheduler {
  set(delayMs: number, callback: () => void): () => void;
}
export type ConnectionState = "connecting" | "ready" | "reconnecting" | "offline" | "fatal";
export interface ClientOptions {
  deviceId: DeviceId;
  /** Pin a directory entry before subscriptions or durable intents can replay. */
  expectedHostId?: HostId;
  transport(): Transport;
  credential(): Promise<Credential>;
  storage: Storage;
  scheduler: Scheduler;
  random(): number;
  id(): string;
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
  heartbeatMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  /**
   * How long a connection must stay up before reconnect backoff starts over. A daemon that
   * accepts and then drops at once keeps backing off instead of being retried at the base delay.
   */
  healthyMs: number;
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
  heartbeatMs: 15000,
  retryBaseMs: 250,
  retryCapMs: 30000,
  healthyMs: 30000,
};
export { ClientError } from "./errors.ts";
export interface RequestOptions {
  /** Optional service correlation selected by the caller, also carried by progress events. */
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
