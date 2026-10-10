import { spawnRawSupervised } from "@ace/provider-kit/process";
export interface DeviceRuntime {
  fetch?: typeof fetch;
  socket?: (url: string) => WebSocket;
  now(): number;
  id(): string;
  after(ms: number, run: () => void): () => void;
  spawn: typeof spawnRawSupervised;
}
export type Capture = {
  readonly terminated?: boolean;
  stop(): Promise<void>;
  restart?(): Promise<void>;
};
