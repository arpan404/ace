import { WebSocket } from "ws";
import { attachFilesChannel } from "./socket.ts";
import type { FilesService } from "./service.ts";

export function attachFilesSocket(
  service: FilesService,
  socket: WebSocket,
  device: string,
  authorize: (capability: "files.read" | "files.write") => boolean = () => true,
) {
  const write = (data: string | Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Socket closed"));
        return;
      }
      socket.send(data, { binary: Buffer.isBuffer(data) }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  return attachFilesChannel(
    service,
    {
      get isOpen() {
        return socket.readyState === WebSocket.OPEN;
      },
      get bufferedBytes() {
        return socket.bufferedAmount;
      },
      sendControl: (message) => write(JSON.stringify(message)),
      sendBinary: write,
      onClose(listener) {
        socket.once("close", listener);
        return () => socket.off("close", listener);
      },
      close() {
        socket.terminate();
      },
    },
    device,
    authorize,
  );
}
