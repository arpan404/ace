import type { BrowserCaptureViewport, BrowserState, ThreadId } from "@ace/protocol";
import { DeviceSettings } from "@ace/ui-core/browser-device-settings";
import {
  deviceLabel,
  devicePresets,
  emulationFor,
  emulationMatches,
  openingDevice,
  phoneFitEmulation,
  phonePresetFor,
  presetById,
  presetSize,
  rotated,
  sizeForEmulation,
  type DeviceEmulation,
  type DeviceSize,
  type TabEmulation,
} from "@ace/ui-core/browser-devices";
import type { KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";
import type { ClientCore } from "@ace/client";

/*
 * The device the phone shows a tab as (the web's device toolbar), by the ownership rule of ADR
 * 0104. A tab that emulates a device, chosen by an agent or by the person on any screen, keeps it
 * and the phone shows that device. A tab with none gets "this phone" once: the view's own size
 * with the nearest iPhone's scale, touch and user agent, re-sent as the view changes while the
 * tab still shows it. A tab the phone gave a device before and that shows none now had it
 * removed elsewhere: the phone leaves it. Only the person's picks here send anything else, as the
 * same `emulate` the web sends.
 */

/** The menu's "This phone": the automatic device, chosen again by hand. */
export const thisPhone = "this-phone";

export const DeviceAction = z.discriminatedUnion("kind", [
  /** Show the tab as a preset (`devicePresets` ids), or as `thisPhone`. */
  z.object({ kind: z.literal("device"), preset: z.string().max(64) }),
  z.object({ kind: z.literal("rotate") }),
  /** The device toolbar above the bar, shown or hidden for the shown tab. */
  z.object({ kind: z.literal("deviceToolbar"), show: z.boolean() }),
]);
export type DeviceAction = z.infer<typeof DeviceAction>;

/** The presets the phone's device menu lists, grouped as the web's; sent once per view. */
export const devicePresetRows = devicePresets.map((preset) => ({
  id: preset.id,
  label: preset.label,
  kind: preset.kind,
  width: preset.width,
  height: preset.height,
}));

interface Watched {
  threadId: ThreadId;
  viewport: BrowserCaptureViewport;
  state: BrowserState | undefined;
}

const tabOf = (watch: Watched) => {
  const tabId = watch.state?.activeTabId;
  return tabId ? watch.state?.tabs?.find((each) => each.tabId === tabId) : undefined;
};

export class PhoneDevices {
  #owner: Pick<ClientCore, "request" | "state">;
  #storage: KeyValueStorage | undefined;
  #store: DeviceSettings | undefined;
  #loaded = false;
  #changed: () => void;
  #waiting: (() => void)[] = [];
  /** The tab the phone chose a device for last (`thread/tab`); a new one is chosen afresh. */
  #decided: string | undefined;
  /** The automatic device the phone last sent each tab, to know it while the tab still shows it. */
  #automatic = new Map<string, DeviceEmulation>();
  constructor(
    owner: Pick<ClientCore, "request" | "state">,
    storage: KeyValueStorage | undefined,
    /** Settles once the phone's store has loaded: nothing is read or written before. */
    ready: Promise<void> = Promise.resolve(),
    /** What the toolbar shows changed (the store loaded, a setting changed). */
    changed: () => void = () => {},
  ) {
    this.#owner = owner;
    this.#changed = changed;
    this.#storage = storage;
    void ready
      .catch(() => {})
      .then(() => {
        this.#loaded = true;
        for (const run of this.#waiting.splice(0)) run();
        this.#changed();
      });
  }
  get #settings(): DeviceSettings {
    return (this.#store ??= new DeviceSettings(this.#storage));
  }
  #whenLoaded(run: () => void): void {
    if (this.#loaded) run();
    else this.#waiting.push(run);
  }
  /** Forget the last choice: after a reconnect the tab is looked at again. */
  reset(): void {
    this.#decided = undefined;
  }
  /** A state arrived: a tab shown for the first time gets its device. */
  observe(watch: Watched): void {
    const state = watch.state;
    const tabId = state?.activeTabId;
    if (!state || state.closed || !tabId || state.status === "paused") return;
    const key = `${watch.threadId}/${tabId}`;
    if (this.#decided === key) return;
    this.#decided = key;
    this.#whenLoaded(() => {
      if (watch.state?.activeTabId !== tabId) return;
      const settings = this.#settings.tab(watch.threadId, tabId);
      const decision = openingDevice(tabOf(watch)?.emulation, settings.applied === true);
      if (decision !== "send") return;
      this.#settings.update(watch.threadId, tabId, { applied: true });
      this.#sendAutomatic(watch, tabId);
    });
  }
  /** The view changed size: a tab still showing "this phone" takes the new size. */
  resized(watch: Watched, before: BrowserCaptureViewport): void {
    const tabId = watch.state?.activeTabId;
    const emulation = tabOf(watch)?.emulation;
    if (!tabId || !emulation || !this.#isAutomatic(watch, tabId, emulation, before)) return;
    this.#sendAutomatic(watch, tabId);
  }
  handle(watch: Watched, action: DeviceAction): void {
    this.#whenLoaded(() => this.#handle(watch, action));
  }
  #handle(watch: Watched, action: DeviceAction): void {
    const tabId = watch.state?.activeTabId;
    if (!tabId) return;
    if (action.kind === "deviceToolbar") {
      this.#settings.update(watch.threadId, tabId, { toolbar: action.show });
      this.#changed();
      return;
    }
    if (action.kind === "device" && action.preset === thisPhone) {
      this.#settings.update(watch.threadId, tabId, { applied: true });
      this.#sendAutomatic(watch, tabId);
      return;
    }
    let size: DeviceSize | undefined;
    if (action.kind === "device") {
      const preset = presetById(action.preset);
      size = preset ? presetSize(preset) : undefined;
    } else {
      const shown = this.#shown(watch);
      size =
        shown?.preset === thisPhone
          ? rotated(presetSize(phonePresetFor(watch.viewport.width)))
          : shown
            ? rotated(shown)
            : undefined;
    }
    if (!size) return;
    this.#settings.update(watch.threadId, tabId, { size, applied: true });
    this.#automatic.delete(`${watch.threadId}/${tabId}`);
    this.#send(watch, tabId, emulationFor(size, watch.viewport.devicePixelRatio));
  }
  /** The device the shown tab is now; undefined while it follows a pane. */
  #shown(watch: Watched): DeviceSize | undefined {
    const tabId = watch.state?.activeTabId;
    const emulation = tabOf(watch)?.emulation;
    if (!tabId || !emulation) return undefined;
    if (this.#isAutomatic(watch, tabId, emulation, watch.viewport))
      return { preset: thisPhone, width: emulation.width, height: emulation.height };
    return sizeForEmulation(emulation);
  }
  /** The device toolbar's state for Swift. */
  view(watch: Watched) {
    const tabId = watch.state?.activeTabId;
    const size = this.#shown(watch);
    return {
      toolbar: tabId && this.#loaded ? this.#settings.tab(watch.threadId, tabId).toolbar : false,
      preset: size?.preset ?? null,
      label: !size ? "Responsive" : size.preset === thisPhone ? "This phone" : deviceLabel(size),
      width: size?.width ?? null,
      height: size?.height ?? null,
      // The person's own Chrome is theirs: ace never resizes it.
      supported: watch.state?.backend !== "user",
    };
  }
  #isAutomatic(
    watch: Watched,
    tabId: string,
    emulation: TabEmulation,
    viewport: BrowserCaptureViewport,
  ): boolean {
    if (emulation.by !== "human") return false;
    const sent = this.#automatic.get(`${watch.threadId}/${tabId}`);
    return (
      (sent !== undefined && emulationMatches(emulation, sent)) ||
      emulationMatches(emulation, phoneFitEmulation(viewport))
    );
  }
  #sendAutomatic(watch: Watched, tabId: string): void {
    const emulation = phoneFitEmulation(watch.viewport);
    this.#automatic.set(`${watch.threadId}/${tabId}`, emulation);
    this.#send(watch, tabId, emulation);
  }
  #send(watch: Watched, tabId: string, emulation: DeviceEmulation): void {
    if (this.#owner.state !== "ready" || watch.state?.backend === "user") return;
    void this.#owner
      .request({
        type: "browser.execute",
        threadId: watch.threadId,
        command: {
          action: "emulate",
          width: emulation.width,
          height: emulation.height,
          deviceScaleFactor: emulation.deviceScaleFactor,
          mobile: emulation.mobile,
          touch: emulation.touch,
          colorScheme: "no-preference",
          ...(emulation.userAgent ? { userAgent: emulation.userAgent } : {}),
          tabId,
        },
      })
      .catch(() => {});
  }
}

/**
 * The device settings' storage on the phone: held in memory, loaded once from the app's store and
 * written back on each change. `ready` settles once the load has (or failed), so nothing reads
 * empty defaults and writes them over the kept tabs.
 */
export function phoneDeviceStorage(native: {
  load(): Promise<string>;
  save(value: string): Promise<void>;
}): { storage: KeyValueStorage; ready: Promise<void> } {
  const values = new Map<string, string>();
  const key = "ace.browser.devices";
  const ready = native
    .load()
    .then((value) => {
      if (value && !values.has(key)) values.set(key, value);
    })
    .catch(() => {});
  return {
    ready,
    storage: {
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => {
        values.set(name, value);
        if (name === key) void native.save(value).catch(() => {});
      },
    },
  };
}
