import type { PreviewChannel } from "./relay-mux.ts";

/** Exclusive binary mode after the owner authenticates hello and authorizes the host channel. */
export function previewRelayChannel(channel: {
  sendBinary(frame: Uint8Array): Promise<void>;
  receiveBinary(): Promise<Uint8Array>;
  close(): void;
  readonly closed: Promise<Error | undefined>;
  readonly bufferedBytes?: number;
  readonly bufferedReceiveBytes?: number;
}): PreviewChannel {
  let subscribed = false;
  return {
    get bufferedBytes() {
      return channel.bufferedBytes ?? 0;
    },
    get bufferedReceiveBytes() {
      return channel.bufferedReceiveBytes ?? 0;
    },
    send: (frame) => channel.sendBinary(frame),
    close: () => channel.close(),
    subscribe(onFrame, onClose) {
      if (subscribed) throw new Error("Preview requires an exclusive relay channel");
      subscribed = true;
      let active = true;
      const finish = () => {
        if (!active) return;
        active = false;
        onClose();
      };
      void channel.closed.then(finish);
      void (async () => {
        try {
          while (true) {
            if (!active) return;
            const frame = await channel.receiveBinary();
            if (!active) return;
            onFrame(frame);
          }
        } catch {
          channel.close();
          finish();
        }
      })();
      return () => {
        active = false;
        channel.close();
      };
    },
  };
}
