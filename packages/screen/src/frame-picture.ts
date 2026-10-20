import type { CapturedPicture } from "@ace/browser/picture-channel";
import type { Frame } from "./frames.ts";

/** The codec a capture's H.264 is in when it doesn't say (Baseline, level 3.1). */
const defaultVideoCodec = "avc1.42E01F";

/**
 * The stream id of a frame's capture. A screen session restarts its capture (and its sequence)
 * under a new generation, so the generation is part of it; a frame without one is the session's
 * only capture.
 */
function streamOf(header: Frame["header"]): string {
  if (!header.captureGeneration) return header.sessionId;
  const suffix = `-g${header.captureGeneration}`;
  return `${header.sessionId.slice(0, 64 - suffix.length)}${suffix}`;
}

/** A captured frame as the picture kinds carry it on the shared media stream. */
export function framePicture(frame: Frame): CapturedPicture {
  const header = frame.header;
  const jpeg = header.codec === "jpeg";
  return {
    sequence: header.sequence,
    timestamp: header.timestamp,
    width: header.width,
    height: header.height,
    scale: header.scale ?? 1,
    rotation: header.rotation ?? 0,
    codec: jpeg ? "jpeg" : (header.videoCodec ?? defaultVideoCodec),
    key: jpeg || header.keyframe === true,
    codecNamed: !jpeg && header.videoCodec !== undefined,
    streamId: streamOf(header),
    bytes: frame.payload,
  };
}
