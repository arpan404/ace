export { DevicesService, type DevicesOptions, agentOwner, deviceFailure } from "./service.ts";
export { DevicePlatform, type PlatformOptions } from "./platform.ts";
export { DeviceChromeReader } from "./device-chrome-reader.ts";
export { deviceChromeSources } from "./device-chrome-sources.ts";
export { DeviceError } from "./sdk.ts";
export { ControllerLease, type Actor } from "./lease.ts";
export { connectDevices, type DevicePeer } from "./bridge.ts";
export { devicesToolkit, type DevicesMachineRoute } from "./mcp.ts";
export { DeviceLogs, type LogBatch } from "./logs.ts";
export type { DeviceRuntime } from "./runtime.ts";

export type { AppDevice as Device } from "@ace/protocol/devices";

export { renderDeviceVideo } from "./video.ts";
export { startCapture, type DeviceCapture } from "./capture.ts";

export { DeviceStreamControl, commonDeviceStream } from "./stream-control.ts";

export { watchDeviceLease } from "./lease-expiry.ts";

export { deviceControlDelivery } from "./control-delivery.ts";
export { consumeDeviceRecording } from "./recording-artifact.ts";
export {
  callSimTool,
  simFailure,
  simPublicError,
  type SimActor,
  type SimResult,
} from "./sim-tools.ts";
export { type SimToolName } from "./sim-schemas.ts";
export { pinnedServeSim, serveSimStatus, type ServeSimStatus } from "./serve-sim-version.ts";
export { managedServeSim, type ServeSimCommand } from "./serve-sim-install.ts";
