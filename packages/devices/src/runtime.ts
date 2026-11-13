import { spawnRawSupervised } from "@ace/provider-kit/process";
export interface DeviceRuntime {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  /** Wall-clock milliseconds, for timestamps. */
  now(): number;
  /**
   * Milliseconds that only move forward, for durations (cowork leases and wait deadlines), so a
   * change to the system clock can't shorten or stretch them. Defaults to `now`.
   */
  monotonic?(): number;
  id(): string;
  after(ms: number, run: () => void): () => void;
  spawn: typeof spawnRawSupervised;
}
export type Capture = {
  readonly terminated?: boolean;
  stop(): Promise<void>;
  restart?(): Promise<void>;
};
