import type { DevicePosture } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";

/** Runs `adb -s <serial> <args>` for one device; resolves with what it printed. */
export type EmulatorConsole = (
  args: readonly string[],
  authorize?: () => void,
) => Promise<{ code: number | null; stdout: string }>;

/** The emulator console's posture numbers: 1 closed, 2 half-opened, 3 opened. */
const postureId: Record<DevicePosture, string> = {
  closed: "1",
  partiallyOpen: "2",
  open: "3",
};

/** Whether `emu sensor status` lists the first hinge sensor as enabled: the device folds. */
export function hasHinge(status: string): boolean {
  return /^\s*hinge-angle0:\s*enabled\b/m.test(status);
}

/**
 * The posture a hinge angle stands for, from `emu sensor get hinge-angle0`, or undefined when
 * the reply holds no angle. Android's foldable emulators call under 30° closed and from 150°
 * open; the band between is half open.
 */
export function postureFromHinge(reply: string): DevicePosture | undefined {
  const match = /hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)/.exec(reply);
  if (!match?.[1]) return undefined;
  const angle = Number(match[1]);
  if (!Number.isFinite(angle)) return undefined;
  if (angle < 30) return "closed";
  if (angle < 150) return "partiallyOpen";
  return "open";
}

/** Reads in a row that found no hinge before a device is taken not to fold. */
const settledReads = 3;

/**
 * Folds Android emulators that have a hinge (the Pixel Fold family and the generic foldables)
 * through the emulator console. A physical phone or an emulator without a hinge has no posture,
 * never an error a person sees.
 */
export class EmulatorPostures {
  private readonly hinged = new Set<string>();
  private readonly unhinged = new Map<string, number>();
  /** The posture of a device ace can fold, or undefined. `id` names it across reads. */
  async read(
    id: string,
    adb: EmulatorConsole,
    authorize?: () => void,
  ): Promise<DevicePosture | undefined> {
    if (!(await this.folds(id, adb, authorize))) return undefined;
    const reply = await adb(["emu", "sensor", "get", "hinge-angle0"], authorize).catch(
      () => undefined,
    );
    if (!reply || reply.code !== 0) return undefined;
    return postureFromHinge(reply.stdout);
  }
  async set(
    id: string,
    adb: EmulatorConsole,
    posture: DevicePosture,
    authorize?: () => void,
  ): Promise<DevicePosture> {
    if (!(await this.folds(id, adb, authorize)))
      throw new DeviceError(
        "not_supported",
        "This device doesn't fold",
        "Only foldable emulators, such as a Pixel Fold, have a posture.",
      );
    const result = await adb(["emu", "posture", postureId[posture]], authorize);
    if (result.code !== 0 || !/^OK\b/m.test(result.stdout))
      throw new DeviceError(
        "not_supported",
        "This emulator couldn't be folded",
        "Fold it from the emulator's extended controls; this emulator may be too old.",
      );
    return posture;
  }
  private async folds(id: string, adb: EmulatorConsole, authorize?: () => void): Promise<boolean> {
    if (this.hinged.has(id)) return true;
    const misses = this.unhinged.get(id) ?? 0;
    if (misses >= settledReads) return false;
    const status = await adb(["emu", "sensor", "status"], authorize).catch(() => undefined);
    // A physical phone has no emulator console; it counts as a miss like a hingeless emulator.
    if (status?.code === 0 && hasHinge(status.stdout)) {
      this.hinged.add(id);
      this.unhinged.delete(id);
      return true;
    }
    this.unhinged.set(id, misses + 1);
    return false;
  }
}
