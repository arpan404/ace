/**
 * Whether the device is saving power, as far as a browser can tell. The Battery Status API
 * (Chromium, so the desktop app too) has no battery-saver flag; ace treats running on battery
 * at 20 % or less as saving power, which is when systems turn their own saver on by default.
 */

export interface BatteryFacts {
  charging: boolean;
  level: number;
}

export const lowBatteryLevel = 0.2;

export function savingPower(battery: BatteryFacts): boolean {
  return !battery.charging && battery.level <= lowBatteryLevel;
}

interface BatteryManagerLike extends BatteryFacts {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface NavigatorWithBattery {
  getBattery(): Promise<BatteryManagerLike>;
}

const hasBattery = (navigator: object): navigator is NavigatorWithBattery =>
  "getBattery" in navigator && typeof navigator.getBattery === "function";

/** Calls `changed` with the power state now and on every change; returns the unsubscribe. */
const noop = () => {};
const batteryEvents = ["chargingchange", "levelchange"] as const;

export function watchSavingPower(
  navigator: object,
  changed: (saving: boolean) => void,
): () => void {
  if (!hasBattery(navigator)) return noop;
  let stopped = false;
  let unwatch = noop;
  navigator.getBattery().then((battery) => {
    if (stopped) return;
    const report = () => changed(savingPower(battery));
    for (const type of batteryEvents) battery.addEventListener(type, report);
    unwatch = () => {
      for (const type of batteryEvents) battery.removeEventListener(type, report);
    };
    report();
  }, noop);
  return () => {
    stopped = true;
    unwatch();
  };
}
