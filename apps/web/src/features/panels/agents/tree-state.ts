import type { Interaction } from "@ace/protocol";
import { createContext } from "react";

/** The tree's roving focus and folded branches, shared by its rows. */
export interface TreeState {
  /** Prefix of the tree's element ids. */
  id: string;
  /** Subagents under each agent, counted once for the whole tree. */
  subagents: ReadonlyMap<string, number>;
  active: string | undefined;
  setActive(id: string): void;
  collapsed: ReadonlySet<string>;
  /** Fold or unfold a row: an agent's subagents, or a group of finished ones. */
  fold(id: string, open: boolean): void;
  /** Groups of finished agents the person opened (folded by default). */
  doneOpen: ReadonlySet<string>;
}

export const Tree = createContext<TreeState>({
  id: "agent-tree",
  subagents: new Map(),
  active: undefined,
  setActive: () => {},
  collapsed: new Set(),
  fold: () => {},
  doneOpen: new Set(),
});

/** The key of the group of `parent`'s finished subagents, among the tree's row ids. */
export const doneGroupId = (parent: string) => `done:${parent}`;

/**
 * Facts a row reads beyond its agent: the request each agent waits on, and the files each
 * changed in the current turn (from the turn index's per-agent digests).
 */
export interface AgentRowFacts {
  requests: ReadonlyMap<string, Interaction>;
  files: ReadonlyMap<string, readonly string[]>;
}

export const RowFacts = createContext<AgentRowFacts>({ requests: new Map(), files: new Map() });
