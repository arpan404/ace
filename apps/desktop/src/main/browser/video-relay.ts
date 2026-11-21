import { encodeEmbeddedVideo } from "@ace/browser/video-encoder";

/*
 * The app's video encoder events to the daemon (ADR 0088, embedded backend): one binary message
 * each on the backend socket (`@ace/browser/video-encoder`). Only a capture's end or an
 * encode's failure comes this way, and always goes; chunks stream into ace-media's ingest.
 */

/** What the relay reads of an encoder event; the daemon parses the whole of it. */
export interface VideoRelayEvent {
  t: string;
  capture: string;
  encode?: string | undefined;
}

/** The app's video encoder, as the backend relays it (`video-encoder.ts`). */
export interface VideoRelaySource {
  onEvent(listener: (event: VideoRelayEvent) => void): () => void;
  stopAll(): void;
}

/** The registered backend socket, as far as binary messages go (`BackendLink.sendBinary`). */
export interface BinaryLink {
  sendBinary?(frame: Uint8Array<ArrayBuffer>, droppable: boolean): boolean;
}

/** A listener for `source.onEvent` that sends each event over the current link, if any. */
export function videoRelay(link: () => BinaryLink | undefined): (event: VideoRelayEvent) => void {
  return (event) => {
    const current = link();
    if (!current?.sendBinary) return;
    let frame: Uint8Array<ArrayBuffer>;
    try {
      frame = encodeEmbeddedVideo(event);
    } catch {
      return;
    }
    current.sendBinary(frame, false);
  };
}
