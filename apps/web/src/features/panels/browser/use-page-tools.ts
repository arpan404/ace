import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { BrowserTabView, BrowserView, PreviewSource } from "../sources.ts";
import { useTabDevice, type TabDevice } from "./device-settings.ts";
import {
  emulationFor,
  presetById,
  presetSize,
  responsiveSize,
  rotated,
  sizeForEmulation,
  type DeviceEmulation,
  type DeviceScale,
  type DeviceSize,
} from "./devices.ts";
import { reason } from "./use-browser-features.ts";
import { zoomForKey } from "@ace/ui-core";

/** A device size settles this long after the last change (a drag) before the page takes it. */
const settleMs = 120;

/**
 * The shown tab's device toolbar and zoom. The device toolbar is this device's view of the
 * tab (kept per tab, `device-settings.ts`); the page is told the device through `emulate`, so
 * agents and other screens see it too. An agent's `emulate` or `resize` opens the toolbar at
 * the agent's size. Zoom is the tab's, kept by the daemon.
 */
export function usePageTools(input: {
  source: PreviewSource;
  threadId: string;
  live: BrowserView | undefined;
  tab: BrowserTabView | undefined;
  online: boolean;
  /** The page area's size now, for a new Responsive size and for leaving device mode. */
  area(): { width: number; height: number } | undefined;
}) {
  const { source, threadId, tab, live, online } = input;
  const toast = useToast();
  const tabId = tab?.tabId;
  const { device, update, preview } = useTabDevice(threadId, tabId);
  const browserScale = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const toolbar = !!device?.toolbar && !!tab;
  const size = device?.size;
  const wanted = toolbar && size ? emulationFor(size, browserScale) : undefined;
  const agentDevice = tab?.emulation?.by === "agent" ? tab.emulation : undefined;
  const engine = live?.backend;
  // The person's own Chrome is theirs: ace never resizes or zooms it.
  const supported = !!live && engine !== "user" && online;

  // An agent set a device or size: show it, at the agent's size.
  const adopted = useRef<string>(undefined);
  useEffect(() => {
    if (!agentDevice || !tabId) return;
    const key = agentKey(tabId, agentDevice);
    if (adopted.current === key) return;
    adopted.current = key;
    if (wanted && wanted.width === agentDevice.width && wanted.height === agentDevice.height)
      return;
    update({ toolbar: true, size: sizeForEmulation(agentDevice) });
  }, [agentDevice, tabId, wanted, update]);

  // The page takes the toolbar's device once the size settles; closing the toolbar gives the
  // page the pane's size back.
  const sent = useRef<string>(undefined);
  const emulation = tab?.emulation;
  useEffect(() => {
    if (!supported || !tabId) return;
    if (wanted) {
      if (matches(emulation, wanted)) {
        sent.current = undefined;
        return;
      }
      const key = `${tabId}:${JSON.stringify(wanted)}`;
      if (sent.current === key) return;
      const timer = setTimeout(() => {
        sent.current = key;
        source
          .emulate(threadId, wanted, tabId)
          .catch((error: unknown) =>
            toast.error({ title: "Couldn't change the page size", description: reason(error) }),
          );
      }, settleMs);
      return () => clearTimeout(timer);
    }
    sent.current = undefined;
    if (toolbar || !emulation) return;
    // An agent's size not shown yet opens the toolbar (above) rather than being undone.
    if (emulation.by === "agent" && adopted.current !== agentKey(tabId, emulation)) return;
    const area = input.area();
    if (area && area.width > 0 && area.height > 0)
      source.resize(threadId, Math.round(area.width), Math.round(area.height));
    // `input.area` reads the layout at the moment it runs; it is not a dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, tabId, threadId, source, toolbar, emulation, JSON.stringify(wanted)]);

  const zoom = tab?.zoom ?? 1;
  const setZoom = (factor: number) => {
    if (!tabId || !source.pageTool) return;
    void source
      .pageTool(threadId, { action: "zoom", factor }, tabId)
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't zoom the page", description: reason(error) }),
      );
  };

  const set = (patch: Partial<TabDevice>) => update(patch);
  return {
    supported,
    /** The device toolbar shows in this tab. */
    toolbar,
    size,
    scale: device?.scale ?? ("fit" as DeviceScale),
    /** What the page is told while the toolbar shows (for the native view's placement too). */
    emulation: wanted,
    showToolbar(show: boolean) {
      set({ toolbar: show });
    },
    /** The first size of a newly shown toolbar: the page area as it is, Responsive. */
    startAt(width: number, height: number) {
      if (!size) set({ size: responsiveSize(width, height) });
    },
    choosePreset(id: string) {
      const preset = presetById(id);
      if (preset) set({ size: presetSize(preset) });
      else if (size) set({ size: responsiveSize(size.width, size.height) });
    },
    resize(width: number, height: number) {
      set({ size: responsiveSize(width, height) });
    },
    /** A size while a handle is dragged: shown at once, kept by `resize` when the drag ends. */
    dragTo(width: number, height: number) {
      preview({ size: responsiveSize(width, height) });
    },
    rotate() {
      if (size) set({ size: rotated(size) });
    },
    setScale(scale: DeviceScale) {
      set({ scale });
    },
    zoom,
    /** Zoom works in every engine but the person's own Chrome. */
    canZoom: supported && !!source.pageTool,
    setZoom,
    /** ⌘= / ⌘+, ⌘- and ⌘0; true when the key was a zoom key. */
    zoomKey(key: string): boolean {
      const next = zoomForKey(key, zoom);
      if (next === undefined) return false;
      if (next !== zoom) setZoom(next);
      return true;
    },
  };
}

export type PageTools = ReturnType<typeof usePageTools>;
export type { DeviceSize };

const agentKey = (tabId: string, emulation: DeviceEmulation) =>
  `${tabId}:${emulation.width}x${emulation.height}:${emulation.deviceScaleFactor}`;

function matches(
  emulation: (DeviceEmulation & { by: "human" | "agent" }) | undefined,
  wanted: DeviceEmulation,
): boolean {
  if (!emulation) return false;
  if (emulation.width !== wanted.width || emulation.height !== wanted.height) return false;
  // An agent's plain size is taken as it is; a preset's scale, touch and agent string are sent.
  if (emulation.by === "agent" && !wanted.mobile && !wanted.touch && !wanted.userAgent) return true;
  return (
    emulation.deviceScaleFactor === wanted.deviceScaleFactor &&
    emulation.mobile === wanted.mobile &&
    emulation.touch === wanted.touch &&
    (emulation.userAgent ?? "") === (wanted.userAgent ?? "")
  );
}
