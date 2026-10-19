import type { ScreenUINode } from "@ace/protocol";

/** An agent-facing element ref, `@e3`; `e3` is accepted too. */
export const simRefPattern = /^@?e[1-9]\d{0,6}$/;
/** The element behind an agent ref, as it was last seen. */
export interface SimElement {
  /** The platform's own ref for the node (Android's dump hash, the iOS AX id, …). */
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly bounds: ScreenUINode["bounds"];
  readonly actions: readonly ScreenUINode["actions"][number][];
}
/** A sim_ui node as agents see it: refs only on nodes they can act on. */
export type SimNode = Omit<ScreenUINode, "ref" | "children"> & {
  ref?: string;
  children: SimNode[];
};
interface Scope {
  next: number;
  /** `e3` → element, oldest first, so the cap evicts the refs seen longest ago. */
  readonly elements: Map<string, SimElement>;
  readonly byRef: Map<string, string>;
  readonly byPrint: Map<string, string>;
}
const maxScopes = 128;
const maxElements = 2048;

/** Same role, name and frame: the same element even when a platform re-numbers its own refs. */
function fingerprint(node: Pick<ScreenUINode, "role" | "name" | "bounds">): string {
  const { x, y, w, h } = node.bounds;
  return JSON.stringify([node.role, node.name, x, y, w, h]);
}
function bare(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

/**
 * Short, stable element refs for device agents, shared by the sim_* tools and the `ace sim` CLI.
 * Each agent gets its own numbering per device. An element keeps its ref across reads while it
 * stays on screen (matched by the platform's ref, else by role, name and frame), so a ref an
 * agent holds stays valid until the element itself goes. Pure: no I/O.
 */
export class SimRefs {
  private readonly scopes = new Map<string, Scope>();

  /**
   * Label one read of the UI. Returns the tree with `@eN` refs on actionable nodes and the
   * elements this read saw, by ref, for re-validation.
   */
  label(
    owner: string,
    deviceId: string,
    nodes: readonly ScreenUINode[],
  ): { nodes: SimNode[]; seen: Map<string, SimElement> } {
    const scope = this.scope(owner, deviceId);
    const seen = new Map<string, SimElement>();
    const visit = (node: ScreenUINode): SimNode => {
      const { ref: platformRef, children, ...rest } = node;
      const labelled: SimNode = { ...rest, children: children.map(visit) };
      if (!node.actions.length) return labelled;
      const print = fingerprint(node);
      const known = [scope.byRef.get(platformRef), scope.byPrint.get(print)].find(
        (id) => id !== undefined && !seen.has(id),
      );
      const id = known ?? `e${++scope.next}`;
      const element: SimElement = {
        ref: platformRef,
        role: node.role,
        name: node.name,
        bounds: node.bounds,
        actions: node.actions,
      };
      seen.set(id, element);
      return { ...labelled, ref: `@${id}` };
    };
    const result = nodes.map(visit);
    for (const [id, element] of seen) this.remember(scope, id, element);
    return { nodes: result, seen };
  }

  /** The element an agent ref named when it was last seen, if this agent was given it. */
  element(owner: string, deviceId: string, ref: string): SimElement | undefined {
    return this.scopes.get(JSON.stringify([owner, deviceId]))?.elements.get(bare(ref));
  }

  private remember(scope: Scope, id: string, element: SimElement): void {
    const previous = scope.elements.get(id);
    if (previous) {
      if (scope.byRef.get(previous.ref) === id) scope.byRef.delete(previous.ref);
      const print = fingerprint(previous);
      if (scope.byPrint.get(print) === id) scope.byPrint.delete(print);
      scope.elements.delete(id);
    }
    scope.elements.set(id, element);
    scope.byRef.set(element.ref, id);
    scope.byPrint.set(fingerprint(element), id);
    while (scope.elements.size > maxElements) {
      const [oldest, gone] = scope.elements.entries().next().value ?? [];
      if (oldest === undefined || !gone) break;
      scope.elements.delete(oldest);
      if (scope.byRef.get(gone.ref) === oldest) scope.byRef.delete(gone.ref);
      const print = fingerprint(gone);
      if (scope.byPrint.get(print) === oldest) scope.byPrint.delete(print);
    }
  }

  private scope(owner: string, deviceId: string): Scope {
    const key = JSON.stringify([owner, deviceId]);
    const existing = this.scopes.get(key);
    if (existing) {
      // Most recently used last, so the cap drops the agent idle longest.
      this.scopes.delete(key);
      this.scopes.set(key, existing);
      return existing;
    }
    const scope: Scope = { next: 0, elements: new Map(), byRef: new Map(), byPrint: new Map() };
    this.scopes.set(key, scope);
    while (this.scopes.size > maxScopes) {
      const oldest = this.scopes.keys().next().value;
      if (oldest === undefined) break;
      this.scopes.delete(oldest);
    }
    return scope;
  }
}
