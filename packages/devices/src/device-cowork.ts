import type { AgentPointer, AgentPointerKind, DeviceActivity, DeviceState } from "@ace/protocol";
import { PersonPresence, personWaitMs, waitedNote } from "@ace/interaction/presence";
import { DeviceError } from "./sdk.ts";
import type { DeviceRuntime } from "./runtime.ts";
import type { DeviceInputWait } from "./input-queue.ts";

/*
 * Cowork on a simulator or emulator (ADR 0143): the person's input from a device view goes in
 * while an agent holds the device, and extends their lease on it; the agent's input waits for
 * that lease to lapse, for at most a minute. Only a person's explicit `controller: "human"`
 * keeps agents out (exclusive), as before.
 */

const surfaceOf = (deviceId: string) => `device:${deviceId}`;

const pointerKinds: Record<string, AgentPointerKind> = {
  tap: "click",
  longPress: "click",
  swipe: "drag",
  type: "type",
  key: "type",
};

export class DeviceCowork {
  private readonly presence: PersonPresence;
  /** Wall-clock time, only for the pointer's timestamp. */
  private readonly epoch: () => number;
  /** Time that only moves forward, for leases, deadlines and waits. */
  private readonly now: () => number;
  private readonly after: DeviceRuntime["after"];
  private readonly pointers = new Map<string, AgentPointer>();
  constructor(
    runtime: Pick<DeviceRuntime, "now" | "monotonic" | "after">,
    changed: (deviceId: string) => void,
  ) {
    this.epoch = runtime.now;
    this.now = runtime.monotonic ?? runtime.now;
    this.after = runtime.after;
    this.presence = new PersonPresence({
      clock: { now: this.now, set: runtime.after },
      changed: (surface) => changed(surface.slice("device:".length)),
    });
  }

  /** The person's input reached this device through a device view. */
  personInput(deviceId: string): void {
    this.presence.input(surfaceOf(deviceId));
  }

  /**
   * Waits while the person uses the device, at most a minute; gives up with `person_busy`
   * having sent nothing. Returns the note a waited action carries, if it waited.
   */
  async yield(deviceId: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
    const outcome = await this.presence.yield(surfaceOf(deviceId), signal);
    if (outcome.busy)
      throw new DeviceError(
        "person_busy",
        `The person is using ${name}; nothing was done`,
        "Try again shortly, or work elsewhere meanwhile.",
      );
    return waitedNote(outcome.waitedMs, name);
  }

  /** One deadline for the initial wait and any retries after losing a queue turn. */
  inputWait(deviceId: string, name: string): DeviceInputWait {
    const deadline = this.now() + personWaitMs;
    let waitedMs = 0;
    const active = () => this.presence.active(surfaceOf(deviceId));
    const busy = () =>
      new DeviceError(
        "person_busy",
        `The person is using ${name}; nothing was done`,
        "Try again shortly, or work elsewhere meanwhile.",
      );
    return {
      active,
      waited: () => waitedNote(waitedMs, name),
      yield: async () => {
        if (!active()) return;
        const left = deadline - this.now();
        if (left <= 0) throw busy();
        const controller = new AbortController();
        const cancel = this.after(left, () => controller.abort(busy()));
        const since = this.now();
        try {
          await this.yield(deviceId, name, controller.signal);
        } finally {
          waitedMs += this.now() - since;
          cancel();
        }
      },
    };
  }

  /** An agent acted on the device; a point there becomes the pointer viewers draw. */
  acted(deviceId: string, activity: Omit<DeviceActivity, "sequence">): void {
    const point = activity.to ?? activity.point;
    if (!point) return;
    this.pointers.set(deviceId, {
      x: point.x,
      y: point.y,
      kind: pointerKinds[activity.action] ?? "click",
      at: Math.max(0, Math.round(this.epoch())),
    });
  }

  /** A device's state with cowork's sharing, the agent's pointer and the person's lease. */
  view(state: DeviceState): DeviceState {
    const pointer = this.pointers.get(state.device.id);
    return {
      ...state,
      sharing: state.controller === "human" ? "exclusive" : "cowork",
      ...(pointer ? { agentPointer: pointer } : {}),
      ...(this.presence.active(surfaceOf(state.device.id)) ? { personActive: true } : {}),
    };
  }
}
