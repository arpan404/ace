import type { ScreenUINode } from "@ace/protocol";

/** A UI tree node with the short ref an agent reading the screen afresh would be given. */
export interface RefNode {
  node: ScreenUINode;
  /** `e7` on elements that can be acted on; none on the rest, as agents see them. */
  ref: string | undefined;
  children: RefNode[];
}

/**
 * Short `@eN` refs for one read of the screen, numbered depth first (an element's children
 * before it) over the elements that can
 * be acted on: what an agent's first `sim_ui` read of this screen shows. Platform refs (long AX
 * ids, dump hashes) never reach the person. Pure.
 */
export function shortRefs(nodes: readonly ScreenUINode[]): RefNode[] {
  let next = 0;
  const visit = (node: ScreenUINode): RefNode => {
    // Children first, as the agents' labelling numbers them.
    const children = node.children.map(visit);
    return { node, ref: node.actions.length ? `e${++next}` : undefined, children };
  };
  return nodes.map(visit);
}
