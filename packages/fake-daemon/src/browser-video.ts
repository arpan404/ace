import { encodeBrowserVideo } from "@ace/browser/stream";
import type { BrowserVideoRequest } from "@ace/protocol";
import type { ScreenFrame } from "./browser.ts";

/** The codec a viewer gets: the first it asked for (the fixture "encodes" any of them). */
export function fakeVideoCodec(video: BrowserVideoRequest | undefined): string | undefined {
  return video?.codecs[0];
}

/**
 * A fixture page picture as one browser video chunk's stream pieces (ADR 0088). The fixture
 * draws SVG rather than encoding H.264: every chunk is a keyframe whose bytes are the picture's
 * SVG data URL, labelled with the codec the viewer asked for. Tests decode it with a stand-in
 * WebCodecs decoder, and `dev:fake` with `installFakeVideoDecoder`, which draws the SVG.
 */
export function fakeVideoChunk(
  id: number,
  threadId: string,
  frame: ScreenFrame,
  codec: string,
  timestamp: number,
): Uint8Array[] {
  return encodeBrowserVideo(
    id,
    threadId,
    {
      sequence: frame.sequence,
      timestamp,
      width: frame.width,
      height: frame.height,
      codedWidth: frame.width,
      codedHeight: frame.height,
      codec,
      key: true,
    },
    new TextEncoder().encode(frame.src),
  );
}
