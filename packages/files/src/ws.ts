import type { FileOperation } from "@ace/protocol";
import { WebSocket } from "ws";
import { attachFilesChannel } from "./socket.ts";
import type { FilesService } from "./service.ts";

/** What a files socket uses: a ws socket, or a daemon socket that behaves like one. */
export interface FilesSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(
    data: string | Buffer,
    options: { binary?: boolean },
    callback: (error?: Error) => void,
  ): void;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  terminate(): void;
}
export function attachFilesSocket(
  service: FilesService,
  socket: FilesSocket,
  device: string,
  authorize: (
    capability: "files.read" | "files.write",
    operation?: FileOperation,
  ) => boolean = () => true,
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
