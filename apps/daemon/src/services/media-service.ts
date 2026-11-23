import { makeDaemonImages } from "./media-images.ts";
import { publishMedia } from "./media.ts";
import type { ServiceContext } from "./types.ts";

/**
 * The daemon's `media` service: its one ace-media, which the screen, the devices and the
 * browser all stream into and every client watches, and its one image worker. Each service
 * starts with its own view of `services`, so both are made here, once, and published for them;
 * made by each of them, a tab would stream into one ace-media while its viewers watched another,
 * and every service would run its own image worker under its own limits.
 */
export function startMediaService(context: ServiceContext): void {
  publishMedia(context);
  // The image worker's process starts only when a picture is first resized.
  context.services.images = makeDaemonImages(context);
}
