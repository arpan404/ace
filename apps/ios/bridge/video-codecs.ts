import { host } from "./host.ts";

/** Old hosts and devices without hardware HEVC retain H.264. */
export function nativeVideoCodecs(): string[] {
  return host.video?.decoders() ?? ["avc1.42E033"];
}
