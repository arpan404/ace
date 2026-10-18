import type { BrowserInput } from "@ace/protocol";

/** Page zoom steps, as browsers and the desktop's native view take them. */
export type ZoomStep = "in" | "out" | "reset";
const factor = 1.2;
const smallest = 0.25;
const largest = 5;

/** The zoom after one step: ×1.2 or ÷1.2, kept between 25% and 500%; reset is 100%. */
export function nextZoom(current: number, step: ZoomStep): number {
  if (step === "reset") return 1;
  const next = step === "in" ? current * factor : current / factor;
  // Snap near 100% so in-then-out comes back exactly.
  const snapped = Math.abs(next - 1) < 1e-9 ? 1 : next;
  return Math.min(largest, Math.max(smallest, snapped));
}

/** ⌘/Ctrl with +, =, - or 0 pressed in a page: a zoom step, not a key for the page. */
export function zoomChord(input: BrowserInput): ZoomStep | undefined {
  if (input.kind !== "key") return undefined;
  // Modifiers are CDP's bit mask: Alt 1, Ctrl 2, Meta 4, Shift 8.
  if ((input.modifiers & 6) === 0 || (input.modifiers & 1) !== 0) return undefined;
  if (input.key === "+" || input.key === "=") return "in";
  if (input.key === "-") return "out";
  if (input.key === "0") return "reset";
  return undefined;
}
