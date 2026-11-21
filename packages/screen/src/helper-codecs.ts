/*
 * What each screen helper encodes, from its hello's capabilities, and the codec ace-media's plan
 * wants of it. Pure: the media source and the session's stream requests read these.
 */

/**
 * Whether a screen helper makes its own video, which it writes only to ace-media's ingest: the
 * Mac's (VideoToolbox), Windows' where its start-up trial found a Media Foundation H.264
 * encoder, and Linux's where one of its encoders (VA-API, NVENC or the last resort) worked. A
 * helper offering only JPEG has no live video; its stills still serve agents.
 */
export function helperEncodesVideo(
  capabilities: { platform: string; codecs: readonly string[] } | undefined,
): boolean {
  return (
    (capabilities?.platform === "macos" ||
      capabilities?.platform === "windows" ||
      capabilities?.platform.startsWith("linux") === true) &&
    capabilities.codecs.includes("h264")
  );
}

/** Whether a helper encodes HEVC toward ace-media's ingest: the Mac's, where its hardware HEVC encode trial worked. */
export function helperEncodesHevc(
  capabilities: { platform: string; codecs: readonly string[] } | undefined,
): boolean {
  return capabilities?.platform === "macos" && capabilities.codecs.includes("hevc");
}

/** HEVC Main at level 5.1, what the Mac helper's encoder names its HEVC stream. */
export const hevcMain = "hvc1.1.6.L153.B0";

/**
 * The codec ace-media's plan wants of a one-stream producer that encodes HEVC: HEVC only when
 * every planned encode is HEVC, since a view planned in H.264 can't take it.
 */
export function wantedCodec(encodes: readonly { codec: string }[]): "h264" | "hevc" {
  return encodes.length > 0 && encodes.every((encode) => isHevc(encode.codec)) ? "hevc" : "h264";
}

const isHevc = (codec: string) => codec.startsWith("hvc1") || codec.startsWith("hev1");
