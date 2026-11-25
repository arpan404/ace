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
/** One operation on the Simulator's held fingers, with the messages it sends serve-sim. */
export function nativeFingerStep(op: unknown, held: unknown) {
  return deviceAnswer<{ held: unknown; messages: { tag: number; payload: unknown }[] }>(() =>
    nativeDevices().devicePlatformFingerStep(JSON.stringify(op), JSON.stringify(held)),
  );
}

/** One finger message as the digitizer step Xcode's helper takes. */
export function nativeDigitizerStep(message: unknown, target: number) {
  return deviceAnswer(() =>
    nativeDevices().devicePlatformDigitizerStep(JSON.stringify(message), target),
  );
}

/** What a Simulator key does: press a message, type a line, or refuse. */
export function nativeKeyAction(
  key: string,
  orientation: string,
): { kind: "press"; message: { tag: number; payload: unknown } } | { kind: "type"; text: string } {
  return deviceAnswer(() => nativeDevices().devicePlatformKeyAction(key, orientation));
}

/** A device point as serve-sim's normalized one, refused outside the frame. */
export function nativeNormalizedPoint(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return deviceAnswer(() => nativeDevices().devicePlatformNormalizedPoint(x, y, width, height));
}

/** serve-sim's system-edge flag for a normalized point. */
export function nativeScreenEdge(x: number, y: number): number {
  return nativeDevices().devicePlatformScreenEdge(x, y);
}

/** What one line of the Android UI helper's stdout says. */
export function nativeHelperReply(
  line: string,
): { kind: "ready" } | { kind: "answer"; line: string } | { kind: "ignored" } {
  return JSON.parse(nativeDevices().devicePlatformHelperReply(line));
}

/** The XML an `OK ` answer carries, or the failure an `ERR ` answer names. */
export function nativeHelperTree(reply: string): string {
  return deviceAnswer(() => nativeDevices().devicePlatformUiHelperTree(reply));
}

/** Whether a line answers the input marker, and whether the command succeeded. */
export function nativeInputAnswer(line: string, marker: string): boolean | null {
  return nativeDevices().devicePlatformInputAnswer(line, marker);
}

/** One pasteboard command's plan: its arguments, byte cap and deadline. */
export function nativePasteboardPlan(verb: string, udid: string) {
  return JSON.parse(nativeDevices().devicePlatformPasteboardPlan(verb, udid)) as {
    args: string[];
    readBytes: number;
    timeoutMs: number;
  };
}

/** A `bigint` as its digits: JSON has no bigint, and every bit must survive. */
export function withBigInts(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** One event of the scrcpy clipboard: the machine's state in and out. */
export function nativeClipboardStep(state: string | null, event: unknown) {
  return deviceAnswer<{ state: unknown; out: unknown[] }>(() =>
    nativeDevices().devicePlatformScrcpyClipboardStep(state, JSON.stringify(event, withBigInts)),
  );
}

/** One step of the held scrcpy pointers: applying an input, or lifting every held finger. */
export function nativeHeldPointersStep(state: string | null, input?: unknown) {
  return JSON.parse(
    nativeDevices().devicePlatformHeldPointersStep(
      state,
      input === undefined ? undefined : JSON.stringify(input),
    ),
  ) as { state: unknown; released: unknown[] };
}

/** How many decisions the addon has answered; a test reads it to prove a path reached Rust. */
export function nativeCalls(): number {
  return nativeDevices().devicePlatformNativeCalls();
}

/** A new reader in the addon, whose buffer stays there; only each chunk crosses. */
export function nativeDeviceReaderNew(): number {
  return nativeDevices().devicePlatformScrcpyDeviceReaderNew();
}

/** One socket chunk through that reader. */
export function nativeDeviceReaderPush(id: number, chunk: Buffer) {
  return deviceAnswer<{ messages: { type: string }[] }>(() =>
    nativeDevices().devicePlatformScrcpyDeviceReaderPush(id, chunk.toString("hex")),
  );
}

/** Lets the reader's buffer go with its socket. */
export function nativeDeviceReaderDrop(id: number): void {
  nativeDevices().devicePlatformScrcpyDeviceReaderDrop(id);
}

/** The `/ax` read's body cap and deadline. */
export function nativeAxLimits(): { bodyBytes: number; timeoutMs: number } {
  return JSON.parse(nativeDevices().devicePlatformSimulatorAxLimits());
}

export function nativeAndroidTree(xml: string, options: unknown): NativeTree {
  return deviceAnswer(() =>
    nativeDevices().devicePlatformAndroidTree(xml, JSON.stringify(options)),
  );
}

export function nativeAndroidFind(tree: NativeTree, options: unknown): NativeTree {
  // The addon answers the tree itself, not an envelope: a bad tree is its caller's bug.
  return JSON.parse(
    nativeDevices().devicePlatformAndroidFind(JSON.stringify(tree), JSON.stringify(options)),
  ) as NativeTree;
}

export function nativeAndroidTarget(tree: NativeTree, ref: string): NativeNode {
  return deviceAnswer(() => nativeDevices().devicePlatformAndroidTarget(JSON.stringify(tree), ref));
}

export type NativeActInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x: number; y: number; toX: number; toY: number; durationMs: number }
  | { kind: "none"; method: string };

export function nativeAndroidAct(node: NativeNode, action: unknown): NativeActInput {
  return deviceAnswer<NativeActInput>(() =>
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
  // The addon answers the layout itself, not an envelope.
  return JSON.parse(
    nativeDevices().devicePlatformSimulatorLayout(JSON.stringify(raw), JSON.stringify(screen)),
  ) as { width: number; height: number; turn: 0 | 90 | 180 | 270 };
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
