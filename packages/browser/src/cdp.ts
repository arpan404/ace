import { z } from "zod";

export const AXTree = z.object({
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      ignored: z.boolean(),
      backendDOMNodeId: z.number().int().optional(),
      childIds: z.array(z.string()).optional(),
      role: z.object({ value: z.unknown() }).optional(),
      name: z.object({ value: z.unknown() }).optional(),
      value: z.object({ value: z.unknown() }).optional(),
    }),
  ),
});
export const ResolvedNode = z.object({ object: z.object({ objectId: z.string() }) });
export const CallResult = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.unknown().optional(),
});
export const Bounds = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export const Screencast = z.object({
  sessionId: z.number().int(),
  data: z.string().max(4 * 1024 * 1024),
  metadata: z.object({
    deviceWidth: z.number(),
    deviceHeight: z.number(),
    timestamp: z.number().finite().optional(),
  }),
});
export interface SnapshotNode {
  id: string;
  ref?: string;
  role: string;
  name: string;
  value?: string;
  children: string[];
  ignored: boolean;
}
export function snapshotNodes(tree: z.infer<typeof AXTree>, epoch: number): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  let bytes = 0;
  for (const node of tree.nodes) {
    const output: SnapshotNode = {
      id: node.nodeId,
      ignored: node.ignored,
      role: String(node.role?.value ?? "").slice(0, 128),
      name: String(node.name?.value ?? "").slice(0, 1024),
      children: node.childIds?.slice(0, 10_000) ?? [],
    };
    if (node.backendDOMNodeId) output.ref = `e${epoch}-${node.backendDOMNodeId}`;
    if (node.value) output.value = String(node.value.value).slice(0, 1024);
    bytes += Buffer.byteLength(JSON.stringify(output));
    if (nodes.length >= 10_000 || bytes > 512 * 1024) break;
    nodes.push(output);
  }
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) node.children = node.children.filter((id) => ids.has(id));
  return nodes;
}
