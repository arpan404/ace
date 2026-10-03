import type { FilesServerMessage } from "@ace/protocol";
import { attachFilesChannel } from "./socket.ts";
import type { FilesService } from "./service.ts";

/** Structural contract: no runtime dependency from the file package to the relay app. */
export interface FilesRelayChannel {
  send(message: FilesServerMessage): Promise<void>;
  sendBinary(bytes: Uint8Array): Promise<void>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
  readonly bufferedBytes: number;
}
/** Attach only after the relay owner authenticates its hello and authorizes the channel. */
export function attachFilesRelay(
  service: FilesService,
  channel: FilesRelayChannel,
  device: string,
  authorize: (capability: "files.read" | "files.write") => boolean,
) {
  let ended = false;
  void channel.closed.then(() => {
    ended = true;
  });
  return attachFilesChannel(
    service,
    {
      get isOpen() {
        return !ended;
      },
      get bufferedBytes() {
        return channel.bufferedBytes;
      },
      sendControl: (message) => channel.send(message),
      sendBinary: (frame) => channel.sendBinary(frame),
      onClose(listener) {
        let active = true;
        void channel.closed.then(() => {
          if (active) listener();
        });
        return () => {
          active = false;
        };
      },
      close() {
        ended = true;
        channel.close();
      },
    },
    device,
    authorize,
  );
}
