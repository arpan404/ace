// SPDX-License-Identifier: Apache-2.0

/**
 * The device platform `@ace/devices` constructs (D3.1, ADR 0225). The switch is read here, once
 * per process, and decides which class `new DevicePlatform(...)` is: with `ACE_DEVICE_PLATFORM`
 * unset it is today's TypeScript; with it set to `native` it is `NativeDevicePlatform`, whose
 * ported methods ask `ace-devices` and inherit every method that item has not reached yet.
 * With the switch on and no addon the platform fails at its first native call, never falling
 * back to the TypeScript path.
 */
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";

import { NativeDevicePlatform } from "./native-platform.ts";
import { DevicePlatformBase } from "./platform-base.ts";

export { type PlatformOptions, type ScreenBinding } from "./platform-base.ts";

/** The class the platform is built from: the ported one under the switch, today's otherwise. */
export const DevicePlatform =
  devicePlatformBackend() === "native" ? NativeDevicePlatform : DevicePlatformBase;

/**
 * Every method's type comes from the base class, so a subclass that overrides a method keeps its
 * signature and the rest of the platform keeps compiling against the one interface.
 */
export type DevicePlatform = DevicePlatformBase;
