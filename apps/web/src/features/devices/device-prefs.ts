import { useSyncExternalStore } from "react";
import { z } from "zod";
import { webStorage } from "@/boot/web-storage.ts";
import { recentLimit, rememberUse, type DeviceUse } from "./device-catalog.ts";

/*
 * What the Devices views remember on this machine, never on the daemon: the devices this person
 * used lately, the drawer under a device's screen, and whether the screen shows without its
 * frame. Read leniently: anything unreadable falls back to the default.
 */

const storage = webStorage(() => globalThis.localStorage);

class Remembered<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();
  private readonly key: string;
  constructor(key: string, schema: z.ZodType<T>, fallback: T) {
    this.key = key;
    let stored: unknown;
    try {
      stored = JSON.parse(storage.getItem(key) ?? "null");
    } catch {
      stored = undefined;
    }
    const parsed = schema.safeParse(stored);
    this.value = parsed.success ? parsed.data : fallback;
  }
  get = (): T => this.value;
  set(next: (previous: T) => T): void {
    this.value = next(this.value);
    try {
      storage.setItem(this.key, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked: the choice lasts for this window.
    }
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

const DeviceUses = z
  .array(z.object({ id: z.string().max(256), at: z.number().finite() }))
  .max(recentLimit * 4);

export type DrawerSection = "logs" | "tree" | "app";
const Drawer = z.object({
  open: z.boolean(),
  height: z.number().finite().min(0).max(4000),
  section: z.enum(["logs", "tree", "app"]),
});
export type DrawerPrefs = z.infer<typeof Drawer>;
export const drawerHeights = { initial: 220, min: 120, max: 560 } as const;

const recent = new Remembered<readonly DeviceUse[]>("ace.devices.recent", DeviceUses, []);
const drawer = new Remembered<DrawerPrefs>("ace.devices.drawer", Drawer, {
  open: false,
  height: drawerHeights.initial,
  section: "logs",
});
const screenOnly = new Remembered<boolean>("ace.devices.screen-only", z.boolean(), false);

function useRemembered<T>(store: Remembered<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The devices used lately on this machine, newest first. */
export const useRecentUses = () => useRemembered(recent);
/** Remember that this person opened a device now. */
export function noteDeviceUse(id: string, at: number): void {
  recent.set((uses) => rememberUse(uses, id, at));
}

export const useDrawerPrefs = () => useRemembered(drawer);
export function setDrawerPrefs(change: Partial<DrawerPrefs>): void {
  drawer.set((previous) => ({ ...previous, ...change }));
}

/*
 * Boot asked for from the list, carried out by the device's own tab once it has loaded the
 * device: the list's channel may close as its tab hides, so the tab that stays does the work.
 * In memory only: a boot asked for before a reload isn't repeated after it.
 */
const bootRequests = new Set<string>();
export function requestBoot(id: string): void {
  bootRequests.add(id);
}
/** Whether a boot was asked for this device, forgetting the request. */
export function takeBootRequest(id: string): boolean {
  return bootRequests.delete(id);
}

/** The screen without its drawn hardware. */
export const useScreenOnly = () => useRemembered(screenOnly);
export function setScreenOnly(value: boolean): void {
  screenOnly.set(() => value);
}
