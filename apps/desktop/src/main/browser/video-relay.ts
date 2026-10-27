import { encodeEmbeddedVideo } from "@ace/browser/video-encoder";
import { VideoChunkGate } from "@ace/browser/video-gate";

/*
 * The app's video encoder events to the daemon (ADR 0088, embedded backend): one binary message
 * each on the backend socket (`@ace/browser/video-encoder`). Chunks and sound are dropped while
 * the socket is backed up, with `VideoChunkGate` keeping what is sent decodable; a capture's end
 * or failure always goes.
 */

/** What the relay reads of an encoder event; the daemon parses the whole of it. */
export interface VideoRelayEvent {
  t: string;
  capture: string;
  encode?: string | undefined;
  key?: boolean | undefined;
}

/** The app's video encoder, as the backend relays it (`video-encoder.ts`). */
export interface VideoRelaySource {
  onEvent(listener: (event: VideoRelayEvent, bytes: Uint8Array | undefined) => void): () => void;
  keyframe(capture: string, encode: string): void;
  stopAll(): void;
}

/** The registered backend socket, as far as binary messages go (`BackendLink.sendBinary`). */
export interface BinaryLink {
  sendBinary?(frame: Uint8Array<ArrayBuffer>, droppable: boolean): boolean;
}

/** The daemon's WebSocket closes on a larger message (`maxPayload`). */
const messageLimit = 1024 * 1024;

/** A listener for `source.onEvent` that sends each event over the current link, if any. */
export function videoRelay(
  source: VideoRelaySource,
  link: () => BinaryLink | undefined,
): (event: VideoRelayEvent, bytes: Uint8Array | undefined) => void {
  const gate = new VideoChunkGate();
  return (event, bytes) => {
    if (event.t === "ended") gate.forget(event.capture);
    const current = link();
    if (!current?.sendBinary) return;
    let frame: Uint8Array<ArrayBuffer>;
    try {
      frame = encodeEmbeddedVideo(event, bytes);
    } catch {
      return;
    }
    // A message over the limit would close the socket: it is dropped like a refused one.
    const fits = frame.byteLength <= messageLimit;
    if (event.t === "chunk" && event.encode !== undefined) {
      const outcome = gate.offer(
        event.capture,
        event.encode,
        event.key === true,
        () => fits && current.sendBinary?.(frame, true) === true,
      );
      if (outcome.keyframe) source.keyframe(event.capture, event.encode);
      return;
    }
    if (fits) current.sendBinary(frame, event.t === "audio");
  };
}
