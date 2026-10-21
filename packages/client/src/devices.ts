/*
 * The portable device client and artifact downloads (ADR 0056): a subpath of its own, so an app
 * that imports the client's main entry for its first paint doesn't carry the device channel,
 * stream assembly and relay crypto until it opens a device view.
 */
export { DeviceClient, DeviceClientError } from "@ace/devices/client";
export type {
  DeviceClientSnapshot,
  DeviceLogBatch,
  DeviceTransport,
  DeviceClientOptions,
  DevicePicture,
} from "@ace/devices/client";
export { browserDeviceSocket, deviceTransport, authenticatedChannel } from "./device-transport.ts";
export type { AuthenticatedChannelOptions, DeviceConnectionTarget } from "./device-transport.ts";
export { ephemeralRelayKeys, failoverTransport } from "./device-route.ts";
export { downloadArtifact } from "@ace/files/client";
export type { ArtifactChannel, ArtifactSink } from "@ace/files/client";

export {
  coalescedPointerMoves,
  deviceVideoSupported,
  deviceStreamProfile,
  screenStreamProfile,
} from "@ace/devices/stream-profile";
export type { DeviceConnection } from "@ace/devices/stream-profile";
