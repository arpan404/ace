import { type RawData, type WebSocket } from "ws";

export interface SocketInputLimits {
  /** Stop reading a socket once this many of its messages wait for a handler. */
  pauseMessages: number;
  /** ...or once its waiting input reaches this many charged bytes. */
  pauseBytes: number;
  /**
   * Last resort per socket. Frames that ws already read before the pause still arrive,
   * so this sits far above the pause threshold.
   */
  socketBytes: number;
  /** Last resort across every socket. */
  globalBytes: number;
  /** Charged per message on top of its payload, so tiny frames still count. */
  messageOverhead: number;
}
export const defaultSocketInputLimits: SocketInputLimits = {
  pauseMessages: 16,
  pauseBytes: 1024 * 1024,
  socketBytes: 8 * 1024 * 1024,
  globalBytes: 16 * 1024 * 1024,
  messageOverhead: 256,
};

function byteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((bytes, chunk) => bytes + chunk.byteLength, 0)
    : data.byteLength;
}
/**
 * Serializes authenticated async handlers. A socket whose handlers fall behind stops being
 * read (TCP backpressure reaches the peer) and resumes once it drains, so a reconnect burst
 * is delivered in order. Only input that outgrows the last-resort caps closes with 4009.
 */
export class SocketInput {
  private bytes = 0;
  private queued = 0;
  private limits: SocketInputLimits;
  constructor(limits: Partial<SocketInputLimits> = {}) {
    this.limits = { ...defaultSocketInputLimits, ...limits };
  }
  depth(): number {
    return this.queued;
  }
  listen(
    socket: WebSocket,
    receive: (data: RawData, binary: boolean) => Promise<void>,
    onError: (error: unknown) => void,
  ): void {
    const limits = this.limits;
    let queued = 0;
    let bytes = 0;
    let messages: Promise<void> = Promise.resolve();
    const backlogged = () => queued >= limits.pauseMessages || bytes >= limits.pauseBytes;
    socket.on("message", (data, binary) => {
      const charge = byteLength(data) + limits.messageOverhead;
      if (bytes + charge > limits.socketBytes || this.bytes + charge > limits.globalBytes) {
        socket.close(4009, "Message backpressure");
        return;
      }
      queued++;
      bytes += charge;
      this.queued++;
      this.bytes += charge;
      if (backlogged() && !socket.isPaused) socket.pause();
      messages = messages
        .then(() => receive(data, binary))
        .catch((error) => {
          onError(error);
          socket.terminate();
        })
        .finally(() => {
          // Transport buffers may have carried ephemeral credentials. No frame is retained after handling.
          if (!binary) {
            if (Buffer.isBuffer(data)) data.fill(0);
            else if (Array.isArray(data)) for (const chunk of data) chunk.fill(0);
            else new Uint8Array(data).fill(0);
          }
          queued--;
          bytes -= charge;
          this.queued--;
          this.bytes -= charge;
          if (
            socket.isPaused &&
            queued <= limits.pauseMessages / 2 &&
            bytes <= limits.pauseBytes / 2
          )
            socket.resume();
        });
    });
  }
}
