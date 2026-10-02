import { PreviewPort } from "@ace/protocol/preview";
import { z } from "zod";
import { createMux, type PreviewChannel, type PreviewSocket } from "./relay-mux.ts";
export type { PreviewChannel, PreviewSocket } from "./relay-mux.ts";
export { requestHeaders, responseHeaders } from "./headers.ts";

/** A mobile native TCP/HTTP bridge implements this; browser JavaScript cannot. */
export type PreviewLoopbackRuntime = {
  listen(options: {
    port: number;
    maxStreams: number;
    openSocket: (socket: PreviewSocket) => void;
    onFailure: () => void;
  }): Promise<{ url: string; close: () => Promise<void> }>;
};

/** Portable client owner. Runtime supplies loopback I/O and hostname generation. */
export async function openPreviewProxy(options: {
  channel: PreviewChannel;
  port: number;
  runtime: PreviewLoopbackRuntime;
  maxStreams?: number;
}) {
  const port = PreviewPort.parse(options.port);
  const maxStreams = z
    .number()
    .int()
    .min(1)
    .max(512)
    .parse(options.maxStreams ?? 256);
  let closeListener: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const closeLoopback = () => {
    if (closeListener) {
      closing ??= closeListener();
      void closing.catch(() => {});
    }
  };
  const mux = createMux({ channel: options.channel, maxStreams, onClosed: closeLoopback });
  try {
    const listener = await options.runtime.listen({
      port,
      maxStreams,
      openSocket: (socket) => mux.open(socket, port),
      onFailure: mux.close,
    });
    closeListener = listener.close;
    if (mux.stats().closed) {
      await listener.close();
      throw new Error("Preview channel closed during startup");
    }
    return {
      url: listener.url,
      close() {
        mux.close();
        closeLoopback();
        return closing ?? Promise.resolve();
      },
      stats: mux.stats,
    };
  } catch (error) {
    mux.close();
    throw error;
  }
}
export { previewRelayChannel } from "./secure-relay.ts";
