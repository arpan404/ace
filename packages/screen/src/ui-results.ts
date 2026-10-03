import { z } from "zod";
import { ScreenUITree, ScreenUIFindResult } from "@ace/protocol";
const Branch = z.object({ children: z.array(z.unknown()).max(2048) });
/** Check aggregate limits before handing recursive data to Zod. */
function bounded(roots: unknown[], maxNodes: number, maxDepth: number): void {
  const pending = roots.map((node) => ({ node, depth: 0 }));
  let count = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) break;
    if (++count > maxNodes || entry.depth > maxDepth)
      throw new Error("Helper UI tree exceeds caps");
    const { children } = Branch.parse(entry.node);
    if (pending.length + children.length + count > maxNodes)
      throw new Error("Helper UI tree exceeds caps");
    for (const node of children) pending.push({ node, depth: entry.depth + 1 });
  }
}
export function parseUITree(
  data: unknown,
  maxNodes: number,
  maxDepth: number,
): z.infer<typeof ScreenUITree> {
  const envelope = z.object({ root: z.unknown().nullable(), truncated: z.boolean() }).parse(data);
  bounded(envelope.root === null ? [] : [envelope.root], maxNodes, maxDepth);
  return ScreenUITree.parse(data);
}
export function parseUIFind(data: unknown, limit: number): z.infer<typeof ScreenUIFindResult> {
  const envelope = z
    .object({ nodes: z.array(z.unknown()).max(limit), truncated: z.boolean() })
    .parse(data);
  bounded(envelope.nodes, limit, 0);
  return ScreenUIFindResult.parse(data);
}
