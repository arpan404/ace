import { encodeDeviceFrame } from "@ace/browser/stream";
import { deviceScreens } from "./device-screens.ts";

function fixture(screen: keyof typeof deviceScreens): Uint8Array {
  const binary = atob(deviceScreens[screen]);
  const payload = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) payload[index] = binary.charCodeAt(index);
  return payload;
}

/** The same fixture picture as stream kind `deviceFrame` pieces, for a media-stream viewer. */
export function fakeDeviceFrame(options: {
  deviceId: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  screen?: keyof typeof deviceScreens;
  codec?: "jpeg" | "h264";
  keyframe?: boolean;
  id: number;
}): Uint8Array[] {
  const codec = options.codec ?? "jpeg";
  return encodeDeviceFrame(
    options.id,
    options.deviceId,
    {
      sequence: options.sequence,
      timestamp: options.timestamp,
      width: 390,
      height: 844,
      scale: 1,
      rotation: 0,
      codec: codec === "h264" ? "avc1.42E01F" : "jpeg",
      key: codec === "jpeg" || options.keyframe === true,
      streamId: options.sessionId,
    },
    fixture(options.screen ?? "home"),
  );
}

/** The same bounded JPEG fixture packet for fake device and desktop live views. */
export function fakeScreenFrame(options: {
  sessionId: string;
  sequence: number;
  timestamp: number;
  screen?: keyof typeof deviceScreens;
  codec?: "jpeg" | "h264";
  keyframe?: boolean;
}): Uint8Array {
  const payload = fixture(options.screen ?? "home");
  const codec = options.codec ?? "jpeg";
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      sessionId: options.sessionId,
      sequence: options.sequence,
      timestamp: options.timestamp,
      width: 390,
      height: 844,
      scale: 1,
      codec,
      ...(codec === "h264" ? { keyframe: options.keyframe, videoCodec: "avc1.42E01F" } : {}),
      bytes: payload.byteLength,
    }),
  );
  const packet = new Uint8Array(4 + header.byteLength + payload.byteLength);
  new DataView(packet.buffer).setUint32(0, header.byteLength);
  packet.set(header, 4);
  packet.set(payload, 4 + header.byteLength);
  return packet;
}
