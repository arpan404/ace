import type { Emulation } from "../sources.ts";

/** A size the page can take: the pane's own (responsive), or a device's. */
export interface Viewport {
  id: string;
  label: string;
  /** Undefined for responsive: the page follows the pane. */
  emulation?: Emulation;
}

export const viewports: readonly Viewport[] = [
  { id: "responsive", label: "Fit the panel" },
  {
    id: "iphone",
    label: "iPhone 16 Pro · 402 × 874",
    emulation: { width: 402, height: 874, deviceScaleFactor: 3, mobile: true, touch: true },
  },
  {
    id: "pixel",
    label: "Pixel 9 · 412 × 915",
    emulation: { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true, touch: true },
  },
  {
    id: "ipad",
    label: "iPad mini · 744 × 1133",
    emulation: { width: 744, height: 1133, deviceScaleFactor: 2, mobile: true, touch: true },
  },
  {
    id: "laptop",
    label: "Laptop · 1280 × 800",
    emulation: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
  },
  {
    id: "desktop",
    label: "Desktop · 1440 × 900",
    emulation: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
  },
];

export const viewportById = (id: string | undefined): Viewport =>
  viewports.find((each) => each.id === id) ?? (viewports[0] as Viewport);
