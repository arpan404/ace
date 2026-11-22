import type { ThreadId } from "@ace/protocol";

/*
 * Where a resource sits (ADR 0209 §4.2, "bound to a canonical tree"): every thread-scoped
 * resource resolves to one tree's root, and that root to its access. This is the seam the
 * access table (§5.3, `thread_access`) fills: until it does, no tree has access a member can
 * hold, so every member request on a tree is refused.
 */

/** What names something inside a tree. */
export type TreeRef =
  | { thread: ThreadId }
  | { interaction: string }
  | { task: string }
  /** A handle bound to its root when it was made: never re-derived from a later id. */
  | { root: ThreadId };

/** Who may reach a tree through ace (ADR 0209 §5.1). */
export type TreeAccess = {
  owner: string;
  visibility: "org" | "members" | "private";
  /** For `members`: the accounts it is shared with. */
  readers?: readonly string[];
};

export interface TreeResolver {
  /** The root of the tree `ref` is in, or undefined when it can't be placed. */
  root(ref: TreeRef): ThreadId | undefined;
  /** That root's owner and visibility, or undefined when it has none a member can hold. */
  access(root: ThreadId): TreeAccess | undefined;
}

/**
 * Part A's resolver: places threads by their delegation tree and handles by their bound root,
 * and knows no tree's access yet. Interactions and tasks aren't placed until the access table
 * lands, so they are refused.
 */
export function structuralTrees(rootOf: (thread: ThreadId) => ThreadId | undefined): TreeResolver {
  return {
    root(ref) {
      if ("root" in ref) return ref.root;
      if ("thread" in ref) return rootOf(ref.thread) ?? ref.thread;
      return undefined;
    },
    access: () => undefined,
  };
}
