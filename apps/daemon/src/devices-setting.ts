import { setTimeout as delay } from "node:timers/promises";
import type { SettingsService } from "@ace/settings";
import type { LazyDevices } from "./lazy-devices.ts";

/** The newest on/off choice, and whether it still has to be saved (it came from devices). */
type Goal = { enabled: boolean; save: boolean };

/** What to do next to bring devices and the saved setting to the goal. */
function nextDevicesStep(goal: Goal, devicesOn: boolean): "devices" | "save" | "done" {
  if (devicesOn !== goal.enabled) return "devices";
  return goal.save ? "save" : "done";
}

const isBusy = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "busy";

/**
 * Keeps devices and the saved `devices.enabled` in step: devices start as the setting says, a
 * change in Settings turns them on or off, and turning them on from a thread's Devices tab is
 * saved too, so the choice outlasts a restart. Unset means on.
 *
 * Every change goes through one loop that works toward the newest choice, so a slow disable, a
 * quick on-then-off or a change made while devices load always ends on the last choice.
 */
export async function followDevicesSetting(
  devices: LazyDevices,
  settings: Pick<SettingsService, "get" | "set" | "subscribe">,
  log: (error: unknown) => void,
  retryAfter: () => Promise<unknown> = () => delay(100),
): Promise<() => void> {
  let goal: Goal | undefined;
  let running = false;
  let stopped = false;
  /** The state this loop is turning devices to; devices echoing it back is not a new choice. */
  let applying: boolean | undefined;

  const settle = async () => {
    await Promise.resolve();
    // `stopped` and `goal` change from callbacks while this loop awaits.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (!stopped && goal) {
      const target = goal;
      try {
        const step = nextDevicesStep(target, devices.isEnabled());
        if (step === "devices") {
          applying = target.enabled;
          try {
            await devices.setEnabled(target.enabled);
          } finally {
            applying = undefined;
          }
        } else if (step === "save") {
          const { value } = await settings.get("devices.enabled");
          if (goal === target && (value !== false) !== target.enabled)
            await settings.set("devices.enabled", target.enabled, { kind: "global" });
        }
        if (goal !== target) continue;
        // Devices now match, so save if needed. Devices that did not change are closed.
        if (step === "devices" && devices.isEnabled() === target.enabled) continue;
        goal = undefined;
      } catch (error) {
        // Devices still cleaning up after being turned off: try again once they finish.
        if (isBusy(error)) {
          await retryAfter();
          continue;
        }
        log(error);
        if (goal === target) goal = undefined;
      }
    }
    running = false;
  };
  const want = (next: Goal) => {
    goal = next;
    if (running || stopped) return;
    running = true;
    void settle();
  };

  let heard = false;
  const release = await settings.subscribe({ keys: ["devices.enabled"], scope: {} }, (event) => {
    if (event.type !== "changed") return;
    const entry = event.entries.find((each) => each.key === "devices.enabled");
    if (!entry) return;
    heard = true;
    want({ enabled: entry.value !== false, save: false });
  });
  const initial = (await settings.get("devices.enabled")).value;
  if (!heard) want({ enabled: initial !== false, save: false });
  const stopWatching = devices.watchEnabled((enabled) => {
    if (enabled !== applying) want({ enabled, save: true });
  });
  return () => {
    stopped = true;
    stopWatching();
    release();
  };
}
