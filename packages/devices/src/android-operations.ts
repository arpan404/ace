import { z } from "zod";
import { AppDevice, type AppDevice as Device, type DeviceInput } from "@ace/protocol/devices";
import { ScreenUIActOptions, ScreenUIFindOptions } from "@ace/protocol";
import { androidTree, androidFind, androidTarget } from "./android-ui.ts";
import type { AndroidPlatform } from "./android-platform.ts";
import { DeviceError } from "./sdk.ts";

/** Bounded per-device ownership of the guest dump/read/remove transaction. */
export class AndroidOperations {
  private readonly uiReads = new Map<string, Promise<void>>();
  private queuedUIReads = 0;
  private readonly android: AndroidPlatform;
  private readonly input: (
    device: Device,
    input: DeviceInput,
    authorize?: () => void,
  ) => Promise<void>;
  constructor(
    android: AndroidPlatform,
    input: (device: Device, input: DeviceInput, authorize?: () => void) => Promise<void>,
  ) {
    this.android = android;
    this.input = input;
  }
  async tree(device: Device, options: unknown) {
    AppDevice.parse(device);
    if (device.platform !== "android")
      throw new DeviceError(
        "not_supported",
        "Simulator tree uses the approved screen session",
        "Use the device service's Simulator tree operation.",
      );
    if (this.queuedUIReads >= 32)
      throw new DeviceError(
        "busy",
        "Device UI read queue is full",
        "Wait for another UI read to complete.",
      );
    this.queuedUIReads++;
    const previous = this.uiReads.get(device.id) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    this.uiReads.set(device.id, done.promise);
    try {
      await previous;
      return androidTree(await this.android.uiDump(device), options);
    } finally {
      done.resolve();
      this.queuedUIReads--;
      if (this.uiReads.get(device.id) === done.promise) this.uiReads.delete(device.id);
    }
  }

  async find(device: Device, options: unknown) {
    ScreenUIFindOptions.parse(options);
    return androidFind(await this.tree(device, { maxNodes: 512, maxDepth: 16 }), options);
  }
  async act(device: Device, raw: unknown, authorize?: () => void) {
    const action = ScreenUIActOptions.parse(raw);
    const node = androidTarget(
      await this.tree(device, { maxNodes: 512, maxDepth: 16 }),
      action.ref,
    );
    if (
      !node.actions.includes(action.action) ||
      node.states.includes("disabled") ||
      !node.bounds.w ||
      !node.bounds.h
    )
      throw new DeviceError(
        "not_supported",
        "Android UI target does not support this action",
        "Read supported actions from the current tree.",
      );
    if (
      action.action === "select" &&
      typeof action.value === "boolean" &&
      (node.states.includes("checked") || node.states.includes("selected")) === action.value
    )
      return { fallback: false, method: "already_selected" };
    const centre = {
      x: Math.floor(node.bounds.x + node.bounds.w / 2),
      y: Math.floor(node.bounds.y + node.bounds.h / 2),
    };
    if (action.action === "scroll") {
      const scroll = z
        .object({
          dx: z.number().int().min(-1000).max(1000).default(0),
          dy: z.number().int().min(-1000).max(1000).default(0),
        })
        .parse(action.value ?? {});
      if (scroll.dx === 0 && scroll.dy === 0) return { fallback: false, method: "no_scroll" };
      const toX = Math.max(
        node.bounds.x,
        Math.min(node.bounds.x + node.bounds.w - 1, centre.x - scroll.dx),
      );
      const toY = Math.max(
        node.bounds.y,
        Math.min(node.bounds.y + node.bounds.h - 1, centre.y - scroll.dy),
      );
      await this.input(device, { kind: "swipe", ...centre, toX, toY, durationMs: 300 }, authorize);
    } else await this.input(device, { kind: "tap", ...centre }, authorize);
    return { fallback: true, method: "adb.shell.input", boundsCentre: centre };
  }
}
