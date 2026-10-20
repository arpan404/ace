import { videoExtensionFiles } from "./video-extension.gen.ts";

/*
 * What the desktop app needs to encode its views as video (ADR 0088, embedded backend): the
 * encoder ace's Chrome runs in its extension's offscreen document, for the desktop's own hidden
 * encoder page, and the binary framing its events take to the daemon.
 */

export { encodeEmbeddedVideo } from "./embedded-video-wire.ts";

/**
 * The encoder's script (`video-extension/offscreen.ts`, bundled): defines `aceVideo` and reports
 * through `aceVideoEmit(event, bytes)` when the page provides it.
 */
export function videoEncoderScript(): string {
  const script = videoExtensionFiles["offscreen.js"];
  if (!script) throw new Error("The video encoder bundle is missing");
  return script;
}
