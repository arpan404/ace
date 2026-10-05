import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { Bounds, ResolvedNode, CallResult } from "./cdp.ts";
export interface BrowserFrameSession {
  frameId: string;
  cdp: BrowserCdp;
  parentId?: string;
}
/** getBoundingClientRect is frame-local. Add each owner's content origin in its parent document. */
export async function frameOffset(
  frameId: string,
  frames: BrowserFrameSession[],
  check: () => void,
): Promise<{ x: number; y: number }> {
  const frame = frames.find((candidate) => candidate.frameId === frameId);
  if (!frame?.parentId) return { x: 0, y: 0 };
  const parent = frames.find((candidate) => candidate.frameId === frame.parentId);
  if (!parent) throw new Error("Parent frame unavailable");
  const owner = z
    .object({ backendNodeId: z.number() })
    .parse(await parent.cdp.send("DOM.getFrameOwner", { frameId }));
  const { object } = ResolvedNode.parse(
    await parent.cdp.send("DOM.resolveNode", { backendNodeId: owner.backendNodeId }),
  );
  let rect: z.infer<typeof Bounds>;
  try {
    check();
    const result = CallResult.parse(
      await parent.cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function(){this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect();return {x:r.x+this.clientLeft,y:r.y+this.clientTop,width:r.width,height:r.height};}`,
      }),
    );
    if (result.exceptionDetails) throw new Error("Frame owner unavailable");
    rect = Bounds.parse(result.result.value);
  } finally {
    await parent.cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
  check();
  const offset = await frameOffset(parent.frameId, frames, check);
  return { x: offset.x + rect.x, y: offset.y + rect.y };
}
