import { type RawData, type WebSocket } from "ws";

function byteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((bytes, chunk) => bytes + chunk.byteLength, 0)
    : data.byteLength;
}
/** Serializes authenticated async handlers with a global byte cap and per-socket frame cap. */
export class SocketInput {
  private bytes = 0;
  listen(
    socket: WebSocket,
    receive: (data: RawData, binary: boolean) => Promise<void>,
    onError: (error: unknown) => void,
  ): void {
    let queued = 0;
    let messages: Promise<void> = Promise.resolve();
    socket.on("message", (data, binary) => {
      const bytes = byteLength(data);
      if (queued >= 8 || this.bytes + bytes > 16 * 1024 * 1024) {
        socket.close(4009, "Message backpressure");
        return;
      }
      queued++;
      this.bytes += bytes;
      messages = messages
        .then(() => receive(data, binary))
        .catch((error) => {
          onError(error);
          socket.terminate();
        })
        .finally(() => {
          queued--;
          this.bytes -= bytes;
        });
    });
  }
}
