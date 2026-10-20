/**
 * Chromium draws an emulated device at `scale` (`Emulation.setDeviceMetricsOverride`) to fit it
 * into the panel, and then reads CDP input coordinates in the scaled drawing, not in the page's
 * CSS pixels: a click at CSS (x, y) lands at (x / scale, y / scale). Agents and the daemon speak
 * CSS pixels, so the view scales their input to where Chromium expects it.
 */

/** The scale an emulation command leaves the page drawn at: 1 once emulation is cleared. */
export function emulationScale(method: string, params: Record<string, unknown> | undefined) {
  if (method !== "Emulation.setDeviceMetricsOverride") return 1;
  const scale = params?.["scale"];
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Whether a CDP method changes the device metrics (and with them the drawing scale). */
export function changesEmulationScale(method: string): boolean {
  return (
    method === "Emulation.setDeviceMetricsOverride" ||
    method === "Emulation.clearDeviceMetricsOverride"
  );
}

const scaleNumber = (value: unknown, scale: number) =>
  typeof value === "number" && Number.isFinite(value) ? value * scale : value;

/**
 * An `Input.*` command's coordinates (`x`, `y` and each touch point's) moved from the page's CSS
 * pixels into the drawing Chromium dispatches them in. Other fields and other methods pass
 * through unchanged.
 */
export function scaledInput(
  method: string,
  params: Record<string, unknown> | undefined,
  scale: number,
): Record<string, unknown> | undefined {
  if (!params || scale === 1 || !method.startsWith("Input.")) return params;
  const scaled: Record<string, unknown> = { ...params };
  scalePoint(scaled, scale);
  const points = scaled["touchPoints"];
  if (Array.isArray(points))
    scaled["touchPoints"] = points.map((point: unknown) => {
      if (typeof point !== "object" || point === null) return point;
      const copy: Record<string, unknown> = Object.fromEntries(Object.entries(point));
      scalePoint(copy, scale);
      return copy;
    });
  return scaled;
}

function scalePoint(point: Record<string, unknown>, scale: number): void {
  if ("x" in point) point["x"] = scaleNumber(point["x"], scale);
  if ("y" in point) point["y"] = scaleNumber(point["y"], scale);
}
