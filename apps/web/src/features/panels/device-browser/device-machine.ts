import { use } from "react";
import { desktopDeviceTabs } from "@/boot/desktop-device-tabs.ts";
import { ScopedMachines } from "@/lib/machines.ts";

/**
 * The machine whose pages the person opens as device tabs here (ADR 0194): another machine than
 * this window's own, in the desktop app. Undefined on this window's own machine (its pages are
 * the desktop's native views already, and its localhost is this computer's) and in a browser
 * (a web page can't set a proxy, so pages stay ace's Chrome as video).
 */
export function deviceTabMachine(
  scoped: { machine: { id: string; primary: boolean } } | undefined,
  desktop: boolean,
): string | undefined {
  const machine = scoped?.machine;
  return desktop && machine && !machine.primary ? machine.id : undefined;
}

export function useDeviceTabMachine(): string | undefined {
  return deviceTabMachine(use(ScopedMachines), desktopDeviceTabs() !== undefined);
}
