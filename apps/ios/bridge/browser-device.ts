import type { BrowserCaptureViewport, BrowserState, ThreadId } from "@ace/protocol";
import { DeviceSettings } from "@ace/ui-core/browser-device-settings";
import {
  deviceLabel,
  devicePresets,
  emulationFor,
  openingDevice,
  phonePresetFor,
  presetById,
  presetSize,
  rotated,
  sizeForEmulation,
  type DeviceSize,
} from "@ace/ui-core/browser-devices";
import type { KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";
import type { ClientCore } from "@ace/client";

/*
 * The device the phone shows a tab as (the web's device toolbar, ADR 0067 parity). A tab that
 * already emulates a device, chosen by an agent or by the person on another screen, keeps it and
 * the phone shows that device. A tab with none takes the phone's own: the device the person picked
 * for that tab here, else the iPhone nearest this screen's width, so a page opens as a phone page.
 * Each pick is sent as the same `emulate` the web sends; the web then shows it in its own device
 * toolbar rather than quietly undoing it.
 */

export const DeviceAction = z.discriminatedUnion("kind", [
  /** Show the tab as a preset (`devicePresets` ids). */
  z.object({ kind: z.literal("device"), preset: z.string().max(64) }),
  z.object({ kind: z.literal("rotate") }),
  /** The device toolbar above the bar, shown or hidden for the shown tab. */
  z.object({ kind: z.literal("deviceToolbar"), show: z.boolean() }),
]);
export type DeviceAction = z.infer<typeof DeviceAction>;

/** The presets the phone's device menu lists, grouped as the web's. */
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

export class PhoneDevices {
  #owner: Pick<ClientCore, "request" | "state">;
  #storage: KeyValueStorage | undefined;
  #store: DeviceSettings | undefined;
  /** The tab the phone chose a device for last (`thread/tab`); a new one is chosen afresh. */
  #decided: string | undefined;
  constructor(owner: Pick<ClientCore, "request" | "state">, storage: KeyValueStorage | undefined) {
    this.#owner = owner;
    this.#storage = storage;
  }
  /** Read at first use, by when the phone's store has loaded. */
  get #settings(): DeviceSettings {
    return (this.#store ??= new DeviceSettings(this.#storage));
  }
  /** Forget the last choice: after a reconnect the daemon's tabs may have lost their devices. */
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
    const tab = state.tabs?.find((each) => each.tabId === tabId);
    const opening = openingDevice(tab?.emulation, this.#own(watch, tabId));
    if (opening.send) this.#send(watch, tabId, opening.size);
  }
  handle(watch: Watched, action: DeviceAction): void {
    const tabId = watch.state?.activeTabId;
    if (!tabId) return;
    if (action.kind === "deviceToolbar") {
      this.#settings.update(watch.threadId, tabId, { toolbar: action.show });
      return;
    }
    let size: DeviceSize | undefined;
    if (action.kind === "device") {
      const preset = presetById(action.preset);
      size = preset ? presetSize(preset) : undefined;
    } else {
      const shown = this.shown(watch);
      size = shown ? rotated(shown) : undefined;
    }
    if (!size) return;
    this.#settings.update(watch.threadId, tabId, { size });
    this.#send(watch, tabId, size);
  }
  /** The device the shown tab is, as the page has it now; undefined while it follows a pane. */
  shown(watch: Watched): DeviceSize | undefined {
    const tabId = watch.state?.activeTabId;
    const emulation = watch.state?.tabs?.find((each) => each.tabId === tabId)?.emulation;
    return emulation ? sizeForEmulation(emulation) : undefined;
  }
  /** The device toolbar's state for Swift. */
  view(watch: Watched) {
    const tabId = watch.state?.activeTabId;
    const size = this.shown(watch);
    return {
      toolbar: tabId ? this.#settings.tab(watch.threadId, tabId).toolbar : false,
      preset: size?.preset ?? null,
      label: size ? deviceLabel(size) : "Responsive",
      width: size?.width ?? null,
      height: size?.height ?? null,
      // The person's own Chrome is theirs: ace never resizes it.
      supported: watch.state?.backend !== "user",
      presets: devicePresetRows,
    };
  }
  #own(watch: Watched, tabId: string): DeviceSize {
    return (
      this.#settings.tab(watch.threadId, tabId).size ??
      presetSize(phonePresetFor(watch.viewport.width))
    );
  }
  #send(watch: Watched, tabId: string, size: DeviceSize): void {
    if (this.#owner.state !== "ready" || watch.state?.backend === "user") return;
    const emulation = emulationFor(size, watch.viewport.devicePixelRatio);
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
 * written back on each change. A read before the load finishes sees the defaults.
 */
export function phoneDeviceStorage(native: {
  load(): Promise<string>;
  save(value: string): Promise<void>;
}): KeyValueStorage {
  const values = new Map<string, string>();
  const key = "ace.browser.devices";
  void native
    .load()
    .then((value) => {
      if (value && !values.has(key)) values.set(key, value);
    })
    .catch(() => {});
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
      if (name === key) void native.save(value).catch(() => {});
    },
  };
}
