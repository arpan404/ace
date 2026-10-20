import type { DeviceInput } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";
import {
  clipboardTextLimit,
  injectTextLimit,
  keycode,
  type ControlMessage,
  type ScreenSize,
} from "./scrcpy-protocol.ts";

/**
 * One control message, sent `delayMs` after the previous step. A clipboard step finishes only
 * when the server acknowledges its sequence number.
 */
export type InputStep = { message: ControlMessage; delayMs: number };

/** Moves during a timed gesture: about one per display frame. */
const frameMs = 16;
/** Typed text containing anything but printable ASCII goes through the clipboard and paste. */
const plainText = /^[\x20-\x7e]*$/;
const press = (code: number): InputStep[] => [
  { delayMs: 0, message: { type: "keycode", action: "down", keycode: code } },
  { delayMs: 0, message: { type: "keycode", action: "up", keycode: code } },
];

/**
 * Plans the control messages for one device input. Input points are display pixels; the server
 * checks every touch against the current video size, so points are scaled into video pixels and
 * carry that size.
 */
export function scrcpyInputPlan(
  input: DeviceInput,
  display: ScreenSize,
  video: ScreenSize,
  nextSequence: () => bigint,
): InputStep[] {
  const factor = video.width / display.width;
  const touch = (
    action: "down" | "up" | "move" | "cancel",
    x: number,
    y: number,
    pointerId = 0,
    delayMs = 0,
  ): InputStep => {
    // Points are the picture's own pixels over one factor. Its sides are rounded separately,
    // so its height in points can pass the display's: the bound is the picture, not the display.
    const videoX = x * factor;
    const videoY = y * factor;
    if (videoX < 0 || videoY < 0 || videoX >= video.width || videoY >= video.height)
      throw new DeviceError(
        "invalid_data",
        "Input is outside the device screen",
        "Use a point inside the current frame.",
      );
    return {
      delayMs,
      message: {
        type: "touch",
        action,
        pointerId: BigInt(pointerId),
        x: videoX,
        y: videoY,
        screen: video,
        pressure: action === "up" || action === "cancel" ? 0 : 1,
      },
    };
  };
  switch (input.kind) {
    case "pointer":
      return [touch(input.phase, input.x, input.y, input.pointerId)];
    case "tap":
      return [touch("down", input.x, input.y), touch("up", input.x, input.y)];
    case "longPress":
      return [touch("down", input.x, input.y), touch("up", input.x, input.y, 0, input.durationMs)];
    case "swipe": {
      const steps = Math.max(1, Math.ceil(input.durationMs / frameMs));
      const plan = [touch("down", input.x, input.y)];
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        plan.push(
          touch(
            "move",
            input.x + (input.toX - input.x) * t,
            input.y + (input.toY - input.y) * t,
            0,
            input.durationMs / steps,
          ),
        );
      }
      plan.push(touch("up", input.toX, input.toY));
      return plan;
    }
    case "type": {
      if (!input.text) return [];
      if (!plainText.test(input.text)) {
        if (Buffer.byteLength(input.text) > clipboardTextLimit)
          throw new DeviceError("limit", "Text is too long to paste", "Type shorter text.");
        return [
          {
            delayMs: 0,
            message: {
              type: "setClipboard",
              sequence: nextSequence(),
              text: input.text,
              paste: true,
            },
          },
        ];
      }
      const plan: InputStep[] = [];
      for (let start = 0; start < input.text.length; start += injectTextLimit)
        plan.push({
          delayMs: 0,
          message: { type: "text", text: input.text.slice(start, start + injectTextLimit) },
        });
      return plan;
    }
    case "key":
      switch (input.key) {
        case "rotate":
          return [{ delayMs: 0, message: { type: "rotate" } }];
        case "back":
          // Back, or wake the screen when it is off, exactly like a phone's back gesture.
          return [
            { delayMs: 0, message: { type: "backOrScreenOn", action: "down" } },
            { delayMs: 0, message: { type: "backOrScreenOn", action: "up" } },
          ];
        case "home":
          return press(keycode.home);
        case "enter":
          return press(keycode.enter);
        case "power":
          return press(keycode.power);
        case "recents":
          return press(keycode.appSwitch);
      }
  }
}

/** Fingers still down when control moves on are lifted, so the device never keeps a touch. */
export class HeldPointers {
  private readonly held = new Map<number, { x: number; y: number }>();
  apply(input: DeviceInput): void {
    if (input.kind !== "pointer") return;
    const id = input.pointerId ?? 0;
    if (input.phase === "down" || input.phase === "move")
      this.held.set(id, { x: input.x, y: input.y });
    else this.held.delete(id);
  }
  /** Inputs that lift every held finger, and forget them. */
  release(): DeviceInput[] {
    const inputs: DeviceInput[] = [...this.held].map(([pointerId, { x, y }]) => ({
      kind: "pointer",
      phase: "up",
      x,
      y,
      pointerId,
    }));
    this.held.clear();
    return inputs;
  }
}
