import { z } from "zod";
import type { DevicePosture } from "@ace/protocol/devices";
import { postureAngle, readPosture } from "./posture.ts";
import { DeviceError } from "./sdk.ts";

/** A finished command: its exit code and what it printed. */
export type PostureCommand = (
  command: string,
  args: readonly string[],
  authorize?: () => void,
) => Promise<{ code: number | null; stdout: string }>;

export interface SimulatorPosturesOptions {
  /** The screen helper, whose `--sim-posture` mode moves a simulator's hinge. */
  helper: string;
  /** `xcrun`, which runs `devicectl` to read the screens. */
  xcrun: () => Promise<string>;
  run: PostureCommand;
}

const HelperReply = z.object({
  available: z.boolean().optional(),
  done: z.boolean().optional(),
  unavailable: z.string().max(512).optional(),
});

/** The helper's one-line reply, or undefined when it printed something else. */
function reply(stdout: string) {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = HelperReply.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: keep looking.
    }
  }
  return undefined;
}

/**
 * Folds iOS Simulators that have two built-in screens (the iPhone Duo). Whether a device folds
 * is learned once per simulator; one that doesn't, or whose Xcode lacks the hinge service,
 * simply has no posture, never an error a person sees.
 */
export class SimulatorPostures {
  private readonly options: SimulatorPosturesOptions;
  private readonly foldable = new Map<string, Promise<boolean>>();
  private readonly requested = new Map<string, DevicePosture>();
  constructor(options: SimulatorPosturesOptions) {
    this.options = options;
  }
  /** The simulator's posture, or undefined when ace can't fold it. */
  async read(udid: string, authorize?: () => void): Promise<DevicePosture | undefined> {
    const report = await this.displays(udid, authorize);
    if (report === undefined) return undefined;
    const posture = readPosture(report, this.requested.get(udid));
    if (posture === undefined || !(await this.available(udid, authorize))) return undefined;
    return posture;
  }
  /**
   * Folds the simulator to `posture` from where it is now. The screens swap a moment after the
   * hinge settles, so the posture asked for is what it reports until the next read.
   */
  async set(udid: string, posture: DevicePosture, authorize?: () => void): Promise<DevicePosture> {
    const from = await this.read(udid, authorize);
    if (from === undefined)
      throw new DeviceError(
        "not_supported",
        "This device doesn't fold",
        "Only foldable simulators, such as the iPhone Duo, have a posture.",
      );
    const result = await this.options.run(
      this.options.helper,
      [
        "--sim-posture",
        udid,
        "--from",
        String(postureAngle[from]),
        "--to",
        String(postureAngle[posture]),
      ],
      authorize,
    );
    if (result.code !== 0 || reply(result.stdout)?.done !== true) {
      this.foldable.delete(udid);
      throw new DeviceError(
        "not_supported",
        "This simulator couldn't be folded",
        "Fold it from Xcode's device tool; this Xcode may have changed how folding works.",
      );
    }
    this.requested.set(udid, posture);
    return posture;
  }
  private async displays(udid: string, authorize?: () => void): Promise<unknown> {
    const xcrun = await this.options.xcrun();
    const result = await this.options
      .run(
        xcrun,
        [
          "devicectl",
          "device",
          "info",
          "displays",
          "--device",
          udid,
          "--quiet",
          "--json-output",
          "-",
        ],
        authorize,
      )
      .catch(() => undefined);
    if (!result || result.code !== 0) return undefined;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  }
  private available(udid: string, authorize?: () => void): Promise<boolean> {
    let known = this.foldable.get(udid);
    if (!known) {
      known = this.options
        .run(this.options.helper, ["--sim-posture", udid, "--check"], authorize)
        .then((result) => result.code === 0 && reply(result.stdout)?.available === true)
        .catch(() => false);
      this.foldable.set(udid, known);
      // A failed check is asked again next time: the device may not have finished booting.
      void known.then((yes) => {
        if (!yes && this.foldable.get(udid) === known) this.foldable.delete(udid);
      });
    }
    return known;
  }
}
