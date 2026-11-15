import type { OpenMediaSocket } from "./media-connection.ts";

/*
 * The media connection (ADR 0147 §4): a subpath of its own, so a client that never shows live
 * video doesn't load it.
 */
export {
  MediaConnection,
  mediaHello,
  mediaLegacyRetryMs,
  mediaAdmissionMs,
  mediaPingMs,
  mediaRetryMs,
  mediaSettleMs,
  mediaWelcomeMs,
} from "./media-connection.ts";
export { relayMediaStreams } from "./media-relay.ts";
export type { MediaRelayOptions } from "./media-relay.ts";
export type {
  MediaConnectionOptions,
  MediaRelayEvents,
  OpenMediaRelay,
  MediaSocket,
  MediaSocketEvents,
  MediaState,
  OpenMediaSocket,
} from "./media-connection.ts";

/** The platform's `WebSocket` as a media socket: binary messages as bytes, text as strings. */
export const browserMediaSocket: OpenMediaSocket = (url, events) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => events.open());
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === "string") events.message(data);
    else if (data instanceof ArrayBuffer) events.message(new Uint8Array(data));
  });
  socket.addEventListener("close", (event) => events.close(event.code));
  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
  };
};
