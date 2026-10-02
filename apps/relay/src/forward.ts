import type { WebSocket } from "ws";
import { FrameReader, sendFrame } from "./socket.ts";
import type { Limits } from "./config.ts";
export type Peer = { socket: WebSocket; reader: FrameReader };
export type RelayStats = {
  peakBufferedBytes: number;
  pausedReaders: number;
  forwardedFrames: number;
  throttledFrames: number;
  peakReaderBytes: number;
};
export function pairStreams(
  client: Peer,
  host: Peer,
  limits: Limits,
  stats: RelayStats,
  onBackpressure: ((bytes: number) => void) | undefined,
): void {
  const close = () => {
    client.socket.terminate();
    host.socket.terminate();
  };
  client.socket.once("close", close);
  host.socket.once("close", close);
  async function pump(source: Peer, destination: Peer): Promise<void> {
    try {
      while (true) {
        const frame = await source.reader.next();
        if (destination.socket.bufferedAmount + frame.length + 4 > limits.maxBufferedBytes)
          throw new Error("Relay buffer cap");
        const written = sendFrame(destination.socket, frame);
        void written.catch(close);
        stats.forwardedFrames++;
        stats.peakBufferedBytes = Math.max(
          stats.peakBufferedBytes,
          destination.socket.bufferedAmount,
        );
        stats.peakReaderBytes = Math.max(stats.peakReaderBytes, source.reader.bufferedBytes);
        if (destination.socket.bufferedAmount >= limits.highWaterBytes) {
          const release = source.reader.hold();
          stats.pausedReaders++;
          onBackpressure?.(destination.socket.bufferedAmount);
          try {
            await written;
          } finally {
            release();
          }
        }
      }
    } catch {
      close();
    }
  }
  void sendFrame(client.socket, new Uint8Array([1]))
    .then(() => {
      void pump(client, host);
      void pump(host, client);
    })
    .catch(close);
}
