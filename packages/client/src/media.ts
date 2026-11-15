import type { OpenMediaSocket } from "./media-connection.ts";

/*
 * The media connection (ADR 0147 §4): a subpath of its own, so a client that never shows live
 * video doesn't load it.
 */
export {
  MediaConnection,
  mediaHello,
  mediaLegacyRetryMs,
  mediaPingMs,
  mediaRetryMs,
  mediaSettleMs,
  mediaWelcomeMs,
} from "./media-connection.ts";
export type {
  MediaConnectionOptions,
  MediaSocket,
  MediaSocketEvents,
  MediaState,
  OpenMediaSocket,
} from "./media-connection.ts";

/** The platform's `WebSocket` as a media socket: binary messages as bytes, text as strings. */
export const browserMediaSocket: OpenMediaSocket = (url, events) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => events.open();
  socket.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === "string") events.message(data);
    else if (data instanceof ArrayBuffer) events.message(new Uint8Array(data));
  };
  socket.onclose = (event) => events.close(event.code);
  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
  };
};
