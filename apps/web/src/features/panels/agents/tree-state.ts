import type { Interaction, LinkedPullRequest } from "@ace/protocol";
import type { RunAgent } from "@ace/ui-core";
import { createContext } from "react";

/** The tree's roving focus and folded branches, shared by its rows. */
export interface TreeState {
  /** Prefix of the tree's element ids. */
  id: string;
  /** Subagents under each agent, counted once for the whole tree. */
  subagents: ReadonlyMap<string, number>;
  active: string | undefined;
  setActive(id: string): void;
  /** Agents whose subagents the person folded away (open by default). */
  collapsed: ReadonlySet<string>;
  /** Agents whose earlier runs the person opened (folded by default). */
  history: ReadonlySet<string>;
  /** Fold or unfold a row: an agent's subagents, or a lone agent's earlier runs. */
  fold(id: string, open: boolean): void;
}

export const Tree = createContext<TreeState>({
  id: "agent-tree",
  subagents: new Map(),
  active: undefined,
  setActive: () => {},
  collapsed: new Set(),
  history: new Set(),
  fold: () => {},
});

/** The key under which an agent's opened run history is kept with the tab. */
export const historyKey = (agent: string) => `history:${agent}`;

/**
 * Facts a row reads beyond its agent: the request each agent waits on, the files each changed in
 * the current turn (from the turn index's per-agent digests), each agent's earlier runs, the
 * thread's pull requests and whether its agents run on more than one provider.
 */
export interface AgentRowFacts {
  requests: ReadonlyMap<string, Interaction>;
  files: ReadonlyMap<string, readonly string[]>;
  earlier: ReadonlyMap<string, readonly RunAgent[]>;
  prs: readonly LinkedPullRequest[];
  mixedProviders: boolean;
}

export const noRowFacts: AgentRowFacts = {
  requests: new Map(),
  files: new Map(),
  earlier: new Map(),
  prs: [],
  mixedProviders: false,
};

export const RowFacts = createContext<AgentRowFacts>(noRowFacts);
