/// <reference lib="dom" />
import type { ScreenFrameHeader } from "@ace/protocol";
import type { DeviceInput } from "@ace/protocol/devices";
import type { PortableFrame } from "@ace/screen/frames-client";

/** Screen images use encoded pixels; simulator input uses logical window points. */
export function devicePoint(
  header: ScreenFrameHeader,
  bounds: { left: number; top: number; width: number; height: number },
  client: { x: number; y: number },
): { x: number; y: number } | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  const scale = header.scale ?? 1;
  const width = header.width / scale;
  const height = header.height / scale;
  return {
    x: Math.max(
      0,
      Math.min(
        Math.max(0, Math.floor(width - 1)),
        Math.round(((client.x - bounds.left) * width) / bounds.width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        Math.max(0, Math.floor(height - 1)),
        Math.round(((client.y - bounds.top) * height) / bounds.height),
      ),
    ),
  };
}

/** Decode completion backpressures the shared hub. Clear invalidates every old load. */
export function createDeviceImage(
  doc: Document,
  options: {
    now(): number;
    canInput(): boolean;
    active(): boolean;
    input(value: DeviceInput): Promise<void>;
    error(failure: unknown): void;
  },
) {
  const element = doc.createElement("div");
  element.style.cssText = "min-height:100px;background:#111;color:#fff;padding:12px";
  const placeholder = doc.createElement("p");
  placeholder.textContent = "Select a device and start its live view.";
  const image = doc.createElement("img");
  image.alt = "Live device screen";
  image.draggable = false;
  image.style.cssText =
    "display:none;width:100%;height:auto;max-width:480px;touch-action:none;user-select:none";
  element.append(placeholder, image);
  let frame: PortableFrame | undefined;
  let imageURL: string | undefined;
  let finishImage: (() => void) | undefined;
  let generation = 0;
  let pointer: { x: number; y: number; time: number; id: number; generation: number } | undefined;
  function clear() {
    generation++;
    pointer = undefined;
    frame = undefined;
    finishImage?.();
    finishImage = undefined;
    image.removeAttribute("src");
    image.style.display = "none";
    if (imageURL) doc.defaultView?.URL.revokeObjectURL(imageURL);
    imageURL = undefined;
    placeholder.hidden = false;
  }
  async function render(next: PortableFrame) {
    const window = doc.defaultView;
    if (!window || !options.active()) return;
    const stamp = generation;
    const url = window.URL.createObjectURL(new Blob([next.payload], { type: "image/jpeg" }));
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        image.removeEventListener("load", loaded);
        image.removeEventListener("error", failed);
        resolve();
      };
      const loaded = () => {
        if (stamp === generation && options.active()) {
          if (
            frame &&
            (frame.header.width !== next.header.width ||
              frame.header.height !== next.header.height ||
              frame.header.scale !== next.header.scale ||
              frame.header.captureGeneration !== next.header.captureGeneration)
          )
            pointer = undefined;
          frame = next;
          image.style.display = "block";
          placeholder.hidden = true;
        }
        finish();
      };
      const failed = () => {
        if (stamp === generation) options.error(new Error("Unable to decode device frame"));
        finish();
      };
      finishImage = finish;
      image.addEventListener("load", loaded);
      image.addEventListener("error", failed);
      if (imageURL) window.URL.revokeObjectURL(imageURL);
      imageURL = url;
      image.src = url;
    });
    if (stamp !== generation) window.URL.revokeObjectURL(url);
  }
  const position = (event: PointerEvent) =>
    frame
      ? devicePoint(frame.header, image.getBoundingClientRect(), {
          x: event.clientX,
          y: event.clientY,
        })
      : undefined;
  image.addEventListener("pointerdown", (event) => {
    if (pointer || !options.canInput()) return;
    const point = position(event);
    if (!point) return;
    pointer = { ...point, time: options.now(), id: event.pointerId, generation };
    image.setPointerCapture(event.pointerId);
  });
  image.addEventListener("pointercancel", (event) => {
    if (pointer?.id === event.pointerId) pointer = undefined;
  });
  image.addEventListener("pointerup", (event) => {
    const start = pointer;
    pointer = undefined;
    const end = position(event);
    if (
      !start ||
      start.id !== event.pointerId ||
      start.generation !== generation ||
      !end ||
      !options.canInput()
    )
      return;
    const durationMs = Math.max(1, Math.min(10000, Math.round(options.now() - start.time)));
    const gesture: DeviceInput =
      Math.abs(start.x - end.x) + Math.abs(start.y - end.y) > 8
        ? { kind: "swipe", x: start.x, y: start.y, toX: end.x, toY: end.y, durationMs }
        : durationMs >= 500
          ? { kind: "longPress", x: start.x, y: start.y, durationMs }
          : { kind: "tap", ...end };
    void options.input(gesture).catch(options.error);
  });
  return { element, clear, render };
}
