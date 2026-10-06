import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
const Frame = z.object({ id: z.string(), parentId: z.string().optional() });
interface FrameTree {
  frame: z.infer<typeof Frame>;
  childFrames?: FrameTree[] | undefined;
}
const Tree: z.ZodType<FrameTree> = z.lazy(() =>
  z.object({ frame: Frame, childFrames: z.array(Tree).optional() }),
);

export async function pageFrames(sessions: BrowserCdp[]) {
  const output = new Map<string, { frameId: string; cdp: BrowserCdp; parentId?: string }>();
  for (const cdp of sessions) {
    const raw = z.object({ frameTree: Tree }).parse(await cdp.send("Page.getFrameTree"));
    const visit = (tree: FrameTree) => {
      const previous = output.get(tree.frame.id);
      // Child sessions replace parent placeholders; preserve the OOPIF owner's parent.
      const parentId = tree.frame.parentId ?? previous?.parentId;
      output.set(tree.frame.id, {
        frameId: tree.frame.id,
        cdp,
        ...(parentId ? { parentId } : {}),
      });
      if (output.size > 64) throw new Error("Browser frame limit");
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(raw.frameTree);
  }
  return [...output.values()];
}
