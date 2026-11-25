// SPDX-License-Identifier: Apache-2.0

/**
 * The input and UI decisions `ace-devices` makes under `ACE_DEVICE_PLATFORM=native` (D3.2), in
 * one place so each module below the platform keeps one `if`. With the switch off every caller
 * runs today's TypeScript unchanged; with it on every answer comes from the addon, and a missing
 * addon throws rather than falling back.
 */
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";

import type { DeviceError } from "./sdk.ts";
import { deviceAnswer, deviceRefusal } from "./sdk.ts";
import { nativeDevices, type RefusalWord } from "./native-devices-addon.ts";

/** Whether this process reads its input and UI decisions from `ace-devices`. */
export const nativeInput = devicePlatformBackend() === "native";

/** The key a device has no hardware for, or undefined when it has one. */
export function nativeKeyRefusal(ios: boolean, name: string, key: string): DeviceError | undefined {
  const answer = nativeDevices().devicePlatformKeyRefusal(ios, name, key);
  if (answer === null) return undefined;
  return deviceFailure(JSON.parse(answer) as RefusalWord);
}

/** A `DeviceError` from an addon refusal, so `code`, `message` and `hint` all hold. */
export function deviceFailure(word: RefusalWord): DeviceError {
  return deviceRefusal(word);
}

export type NativeTree = { nodes: unknown[]; truncated: boolean };
export type NativeNode = Record<string, unknown>;

/** uiautomator's XML as ADR 0011 nodes. */
export function nativeAndroidTree(xml: string, options: unknown): NativeTree {
  return deviceAnswer(() =>
    nativeDevices().devicePlatformAndroidTree(xml, JSON.stringify(options)),
  );
}

export function nativeAndroidFind(tree: NativeTree, options: unknown): NativeTree {
  return deviceAnswer(() =>
    nativeDevices().devicePlatformAndroidFind(JSON.stringify(tree), JSON.stringify(options)),
  );
}

export function nativeAndroidTarget(tree: NativeTree, ref: string): NativeNode {
  return deviceAnswer(() => nativeDevices().devicePlatformAndroidTarget(JSON.stringify(tree), ref));
}

export function nativeAndroidAct(node: NativeNode, action: unknown) {
  return deviceAnswer<{ kind: "tap" | "swipe" | "none" }>(() =>
    nativeDevices().devicePlatformAndroidAct(JSON.stringify(node), JSON.stringify(action)),
  );
}

/** One device input as the scrcpy server's control messages. */
export function nativeScrcpyInputPlan(
  input: unknown,
  display: { width: number; height: number },
  video: { width: number; height: number },
  nextSequence: () => bigint,
): { delayMs: number; message: Record<string, unknown> }[] {
  const plan = deviceAnswer<{ delayMs: number; message: Record<string, unknown> }[]>(() =>
    nativeDevices().devicePlatformScrcpyInputPlan(
      JSON.stringify(input),
      JSON.stringify(display),
      JSON.stringify(video),
      Number(nextSequence()),
    ),
  );
  // A pointer id is a bigint on the wire; JSON carries it as digits.
  for (const step of plan)
    if (step.message["type"] === "touch" || step.message["type"] === "setClipboard")
      for (const key of ["pointerId", "sequence"])
        if (key in step.message) step.message[key] = BigInt(String(step.message[key]));
  return plan;
}

export function nativeSimulatorScreens(report: unknown) {
  return JSON.parse(nativeDevices().devicePlatformSimulatorScreens(JSON.stringify(report))) as {
    id: number;
    width: number;
    height: number;
    active: boolean;
  }[];
}

export function nativeTouchTarget(
  screens: readonly { id: number; width: number; height: number; active: boolean }[],
  picture: { width: number; height: number } | undefined,
): number {
  return nativeDevices().devicePlatformTouchTarget(
    JSON.stringify(screens),
    picture === undefined ? undefined : JSON.stringify(picture),
  );
}

export function nativeSimulatorTree(
  raw: unknown,
  screen: { width: number; height: number; orientation?: string },
  options: unknown,
): NativeTree {
  return deviceAnswer(() =>
    nativeDevices().devicePlatformSimulatorTree(
      JSON.stringify(raw),
      JSON.stringify(screen),
      JSON.stringify(options),
    ),
  );
}

export function nativeSimulatorLayout(
  raw: unknown,
  screen: { width: number; height: number; orientation?: string },
) {
  return deviceAnswer<{ width: number; height: number; turn: 0 | 90 | 180 | 270 }>(() =>
    nativeDevices().devicePlatformSimulatorLayout(JSON.stringify(raw), JSON.stringify(screen)),
  );
}

export function nativeSimulatorTarget(tree: NativeTree, ref: string): NativeNode {
  return deviceAnswer(() =>
    nativeDevices().devicePlatformSimulatorTarget(JSON.stringify(tree), ref),
  );
}

export function nativeSimulatorActionInput(node: NativeNode, action: unknown, turn: number) {
  return deviceAnswer<{ kind: "tap" | "swipe" | "none" }>(() =>
    nativeDevices().devicePlatformSimulatorActionInput(
      JSON.stringify(node),
      JSON.stringify(action),
      turn,
    ),
  );
}
