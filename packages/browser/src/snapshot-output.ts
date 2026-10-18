import type { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { snapshotNodes, type AXTree, type SnapshotNode } from "./cdp.ts";
import { truncatedHint } from "./snapshot-scope.ts";

/** A frame a snapshot reads; without `frameId`, the page's only document. */
export interface SnapshotFrame {
  frameId?: string | undefined;
  cdp: BrowserCdp;
  parentId?: string | undefined;
}
export interface SnapshotTarget {
  backendNodeId: number;
  cdp: BrowserCdp;
  frameId?: string;
}
type OutputNode = SnapshotNode & { frameId?: string };

const maxNodes = 10_000;
const maxBytes = 512 * 1024;

/**
 * The nodes one snapshot returns and the refs it grants, bounded to `maxNodes` nodes and
 * `maxBytes` of JSON across every frame it reads.
 */
export class SnapshotOutput {
  readonly nodes: OutputNode[] = [];
  readonly refs = new Map<string, SnapshotTarget>();
  truncated = false;
  private bytes = 0;
  private epoch: number;
  constructor(epoch: number) {
    this.epoch = epoch;
  }
  /** Adds one frame's tree; false once the output is full. */
  add(tree: z.infer<typeof AXTree>, frame: SnapshotFrame): boolean {
    const prefix = frame.frameId ? `${frame.frameId}:` : "";
    const nodes = snapshotNodes(tree, this.epoch);
    for (const node of nodes) {
      const backendNodeId = node.ref ? Number(node.ref.split("-")[1]) : undefined;
      const output: OutputNode = {
        ...node,
        id: prefix + node.id,
        children: node.children.map((id) => prefix + id),
        ...(frame.frameId ? { frameId: frame.frameId } : {}),
        ...(node.ref ? { ref: prefix + node.ref } : {}),
      };
      this.bytes += Buffer.byteLength(JSON.stringify(output));
      if (this.nodes.length >= maxNodes || this.bytes > maxBytes) {
        this.truncated = true;
        return false;
      }
      this.nodes.push(output);
      if (output.ref && backendNodeId !== undefined)
        this.refs.set(output.ref, {
          backendNodeId,
          cdp: frame.cdp,
          ...(frame.frameId ? { frameId: frame.frameId } : {}),
        });
    }
    if (nodes.length < tree.nodes.length) this.truncated = true;
    return !this.truncated;
  }
  result(domNodes?: number) {
    return {
      nodes: this.nodes,
      truncated: this.truncated,
      ...(this.truncated ? { hint: truncatedHint } : {}),
      ...(domNodes !== undefined && this.truncated ? { domNodes } : {}),
    };
  }
}
