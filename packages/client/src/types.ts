import type { Credential } from "./credentials.ts";
import type { DeviceId } from "@ace/protocol";

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
export interface Storage {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}
export interface Scheduler {
  set(delayMs: number, callback: () => void): () => void;
}
export type ConnectionState = "connecting" | "ready" | "reconnecting" | "offline" | "fatal";
export interface ClientOptions {
  deviceId: DeviceId;
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
}
export const defaultLimits: Limits = {
  intents: 256,
  threads: 32,
  requests: 256,
  frameBytes: 2 * 1024 * 1024,
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
};
export class ClientError extends Error {
  readonly code:
    | "offline"
    | "timeout"
    | "aborted"
    | "limit"
    | "protocol"
    | "auth"
    | "storage"
    | "daemon";
  constructor(code: ClientError["code"], message: string = code) {
    super(message);
    this.name = "ClientError";
    this.code = code;
  }
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
