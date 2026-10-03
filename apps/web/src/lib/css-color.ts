/*
 * Theme tokens are CSS colours of any syntax (oklch, color-mix, relative colours). Canvas and
 * terminal renderers need plain RGBA, so a token is painted onto one pixel and read back.
 */

let probe: CanvasRenderingContext2D | null | undefined;

/** `value` as straight RGBA, 0..255 per channel; transparent if it does not parse. */
export function rgba(value: string): [number, number, number, number] {
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe || !value) return [0, 0, 0, 0];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "transparent";
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a];
}

/** A token of `element` as an `rgba()` string any parser accepts. */
export function tokenColor(element: Element, token: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  const [r, g, b, a] = rgba(value || fallback);
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
