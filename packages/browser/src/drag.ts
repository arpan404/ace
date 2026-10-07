import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
const Drag = z.object({
  data: z.object({
    items: z
      .array(
        z.object({
          mimeType: z.string().max(256),
          data: z.string().max(65536),
          title: z.string().max(1024).optional(),
          baseURL: z.string().max(8192).optional(),
        }),
      )
      .max(32),
    dragOperationsMask: z.number().int(),
  }),
});
/** Native HTML drag data and pointer-driven controls use the same fenced movement. */
export async function dragRefs(
  cdp: BrowserCdp,
  start: { x: number; y: number },
  end: { x: number; y: number },
  check: () => void,
  cleanupCheck: () => void = check,
  beforeInput?: () => void,
): Promise<void> {
  let pressed = false;
  let point = start;
  let drag: z.infer<typeof Drag>["data"] | undefined;
  const intercepted = (raw: unknown) => {
    const event = Drag.safeParse(raw);
    if (event.success) drag = event.data.data;
  };
  cdp.on("Input.dragIntercepted", intercepted);
  const send = async (method: string, params: Record<string, unknown>) => {
    check();
    if (method === "Input.dispatchMouseEvent") {
      beforeInput?.();
      if (params["type"] === "mousePressed") pressed = true;
      if (typeof params["x"] === "number" && typeof params["y"] === "number")
        point = { x: params["x"], y: params["y"] };
    }
    await cdp.send(method, params);
    if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseReleased")
      pressed = false;
  };
  try {
    await send("Input.setInterceptDrags", { enabled: true });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...start,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    // A single jump can miss drag initiation. Cross its threshold within the source first.
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + 10,
      y: start.y,
      button: "left",
      buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...end,
      button: "left",
      buttons: 1,
    });
    if (drag)
      for (const type of ["dragEnter", "dragOver", "drop"])
        await send("Input.dispatchDragEvent", { type, ...end, data: drag });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...end,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    cdp.off("Input.dragIntercepted", intercepted);
    if (pressed) {
      // Abort stops new movement, but release our held pointer only on the original lease/document.
      try {
        cleanupCheck();
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      } catch {
        /* A new controller or target owns any further input. */
      }
    }
    await cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}
