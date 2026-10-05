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
): Promise<void> {
  let drag: z.infer<typeof Drag>["data"] | undefined;
  const intercepted = (raw: unknown) => {
    const event = Drag.safeParse(raw);
    if (event.success) drag = event.data.data;
  };
  cdp.on("Input.dragIntercepted", intercepted);
  const send = async (method: string, params: Record<string, unknown>) => {
    check();
    await cdp.send(method, params);
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
    await cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}
