import { encodePicture, streamKinds, type PictureKind } from "@ace/browser/stream";
import { deviceScreens } from "./device-screens.ts";

function fixture(screen: keyof typeof deviceScreens): Uint8Array {
  const binary = atob(deviceScreens[screen]);
  const payload = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) payload[index] = binary.charCodeAt(index);
  return payload;
}

/** A fixture picture's size and bytes, as a viewer or a screenshot gets them. */
export const fakePictureSize = { width: 390, height: 844 } as const;
export function fakePictureBytes(screen: keyof typeof deviceScreens = "home"): Uint8Array {
  return fixture(screen);
}

/**
 * A bounded fixture picture as stream pieces, for fake device (`deviceFrame`, named by the device
 * id) and computer-use (`screenFrame`, named by the session id) live views.
 */
export function fakePicture(options: {
  kind: PictureKind;
  sourceId: string;
  streamId: string;
  sequence: number;
  timestamp: number;
  screen?: keyof typeof deviceScreens;
  codec?: "jpeg" | "h264";
  keyframe?: boolean;
  /** A screenshot: outside the paced live view. */
  still?: boolean;
  id: number;
}): Uint8Array[] {
  const codec = options.codec ?? "jpeg";
  return encodePicture(
    options.kind,
    options.id,
    options.sourceId,
    {
      sequence: options.sequence,
      timestamp: options.timestamp,
      ...fakePictureSize,
      scale: 1,
      rotation: 0,
      codec: codec === "h264" ? "avc1.42E01F" : "jpeg",
      key: codec === "jpeg" || options.keyframe === true,
      streamId: options.streamId,
      ...(options.still ? { still: true as const } : {}),
    },
    fixture(options.screen ?? "home"),
  );
}

/** A device's fixture picture as stream kind `deviceFrame` pieces. */
export function fakeDeviceFrame(options: {
  deviceId: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  screen?: keyof typeof deviceScreens;
  codec?: "jpeg" | "h264";
  keyframe?: boolean;
  still?: boolean;
  id: number;
}): Uint8Array[] {
  const { deviceId, sessionId, ...rest } = options;
  return fakePicture({
    ...rest,
    kind: streamKinds.deviceFrame,
    sourceId: deviceId,
    streamId: sessionId,
  });
}
