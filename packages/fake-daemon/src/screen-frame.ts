import { deviceScreens } from "./device-screens.ts";

/** The same bounded JPEG fixture packet for fake device and desktop live views. */
export function fakeScreenFrame(options: {
  sessionId: string;
  sequence: number;
  timestamp: number;
  screen?: keyof typeof deviceScreens;
  codec?: "jpeg" | "h264";
  keyframe?: boolean;
}): Uint8Array {
  const binary = atob(deviceScreens[options.screen ?? "home"]);
  const payload = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) payload[index] = binary.charCodeAt(index);
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
