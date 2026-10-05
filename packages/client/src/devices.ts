/*
 * The portable device client and artifact downloads (ADR 0056): a subpath of its own, so an app
 * that imports the client's main entry for its first paint doesn't carry the device channel,
 * frame decoding and relay crypto until it opens a device view.
 */
export { DeviceClient, DeviceClientError } from "@ace/devices/client";
export type {
  DeviceClientSnapshot,
  DeviceLogBatch,
  DeviceTransport,
  DeviceClientOptions,
} from "@ace/devices/client";
export { browserDeviceSocket, deviceTransport, authenticatedChannel } from "./device-transport.ts";
export type { AuthenticatedChannelOptions, DeviceConnectionTarget } from "./device-transport.ts";
export { downloadArtifact } from "@ace/files/client";
export type { ArtifactChannel, ArtifactSink } from "@ace/files/client";

export {
  coalescedPointerMoves,
  deviceCanvasRenderer,
  deviceVideoSupported,
  deviceStreamProfile,
} from "@ace/devices/video-client";
export type { DeviceConnection } from "@ace/devices/video-client";
