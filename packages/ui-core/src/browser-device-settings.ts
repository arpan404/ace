import * as z from "zod/mini";
import type { DeviceScale, DeviceSize } from "./browser-devices.ts";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/** One tab's device toolbar: shown or not, the size it shows, and how large it is drawn. */
export interface TabDevice {
  toolbar: boolean;
  /** Undefined until the toolbar first opens in this tab (it starts at the page area's size). */
  size: DeviceSize | undefined;
  scale: DeviceScale;
  /**
   * This screen gave the tab its own automatic device once (the phone's "this phone"). A tab
   * marked so and showing no device had it removed elsewhere, so it is not sent again.
   */
  applied?: boolean | undefined;
}

const Size = z.object({ preset: z.string(), width: z.number(), height: z.number() });
const Entry = z.object({
  toolbar: z.boolean(),
  size: z.optional(Size),
  scale: z.union([z.literal("fit"), z.number()]),
  applied: z.optional(z.boolean()),
});
const Tab = z.tuple([z.string(), Entry]);
/** Each tab is read on its own: one entry a later version wrote differently drops only itself. */
const Stored = z.object({
  always: z.optional(z.boolean()),
  tabs: z.optional(z.array(z.unknown())),
});
interface Persisted {
  always: boolean;
  tabs: z.infer<typeof Tab>[];
}

const key = "ace.browser.devices";
/** Tabs remembered: the most recently changed ones. */
const tabLimit = 200;

/**
 * The device toolbar of each browser tab on this device, kept across restarts (tab ids
 * survive a daemon restart, ADR 0083), and whether new tabs open with it ("Always show in new
 * tabs"). Local to the device: it is how this screen shows a page, not what the page is. The web
 * keeps it in local storage; the phone in its own store, through the bridge.
 */
export class DeviceSettings {
  private storage: KeyValueStorage | undefined;
  private value: Persisted;
  private tabs: Map<string, TabDevice>;
  /** One default per unknown tab, so a read returns the same object until something changes. */
  private defaults = new Map<string, TabDevice>();
  private listeners = new Set<() => void>();
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    const stored = readJson(storage, key, Stored, {});
    this.value = {
      always: stored.always ?? false,
      tabs: (stored.tabs ?? []).flatMap((entry) => {
        const parsed = Tab.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    };
    this.tabs = new Map(
      this.value.tabs.map(([id, entry]) => [id, { ...entry, size: entry.size }] as const),
    );
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** New tabs open with the device toolbar. */
  always = (): boolean => this.value.always;
  setAlways(value: boolean): void {
    this.value = { ...this.value, always: value };
    this.save();
  }
  /** A tab's settings; a tab never seen takes "Always show in new tabs". */
  tab(threadId: string, tabId: string): TabDevice {
    const id = `${threadId}/${tabId}`;
    const known = this.tabs.get(id);
    if (known) return known;
    let fallback = this.defaults.get(id);
    if (!fallback) {
      fallback = { toolbar: this.value.always, size: undefined, scale: "fit" };
      this.defaults.set(id, fallback);
    }
    return fallback;
  }
  /** Changes a tab's settings and keeps them. */
  update(threadId: string, tabId: string, patch: Partial<TabDevice>): void {
    this.put(threadId, tabId, patch);
    this.save();
  }
  /** Changes a tab's settings for now only (a drag in progress); `update` keeps them. */
  preview(threadId: string, tabId: string, patch: Partial<TabDevice>): void {
    this.put(threadId, tabId, patch);
    this.defaults.clear();
    for (const listener of this.listeners) listener();
  }
  private put(threadId: string, tabId: string, patch: Partial<TabDevice>): void {
    const id = `${threadId}/${tabId}`;
    const next = { ...this.tab(threadId, tabId), ...patch };
    this.tabs.delete(id);
    this.tabs.set(id, next);
    while (this.tabs.size > tabLimit) {
      const oldest = this.tabs.keys().next().value;
      if (oldest === undefined) break;
      this.tabs.delete(oldest);
    }
  }
  private save(): void {
    this.defaults.clear();
    this.value = {
      always: this.value.always,
      tabs: [...this.tabs].map(([id, entry]) => [
        id,
        {
          toolbar: entry.toolbar,
          scale: entry.scale,
          ...(entry.applied ? { applied: true } : {}),
          ...(entry.size ? { size: entry.size } : {}),
        },
      ]),
    };
    writeJson(this.storage, key, this.value);
    for (const listener of this.listeners) listener();
  }
}
