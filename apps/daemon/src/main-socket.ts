import type { RawData } from "ws";

/**
 * What the main socket handler uses of a client connection: a ws socket on the daemon's own
 * listeners, or a relayed channel wrapped to look like one (`relay-socket.ts`). Keeping the
 * handler on this surface lets both routes share one protocol implementation.
 */
export interface MainSocket {
  readonly readyState: 0 | 1 | 2 | 3;
  readonly bufferedAmount: number;
  readonly isPaused: boolean;
  send(
    data: string | Buffer | Uint8Array,
    options: { binary?: boolean; compress?: boolean },
    callback?: (error?: Error) => void,
  ): void;
  send(data: string | Buffer | Uint8Array, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  off(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
}
