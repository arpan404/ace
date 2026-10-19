import type { BrowserCdp } from "./backend.ts";

/** CDP's drag operations: copy 1, link 2, move 16. A dropped file is offered as a copy. */
const copy = 1;

/**
 * Files from the person's device dropped on the page at `point` (CSS pixels), as a native drag
 * from outside the page: it enters and moves over the point, then drops. The page's own drop
 * zones get `DataTransfer.files`; a page that refuses the drag at that point never sees a drop,
 * as in a browser. `check` runs before each event, so a tab that turned private or closed stops.
 */
export async function dropFiles(
  cdp: BrowserCdp,
  paths: readonly string[],
  point: { x: number; y: number },
  modifiers: number,
  check: () => void,
): Promise<void> {
  const data = { items: [], files: [...paths], dragOperationsMask: copy };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    check();
    await cdp.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data, modifiers });
  }
}
