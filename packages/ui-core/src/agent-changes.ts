import type { TurnDigest, TurnSummary } from "@ace/protocol";

/*
 * A turn's changed files by the agent that changed them, grouped by the checkout each agent
 * works in, with the files two agents both changed in one checkout flagged: their edits may
 * have overwritten each other. Pure.
 */

type DigestFile = TurnDigest["files"][number];

export interface AgentFiles {
  agentId: string;
  /** The checkout the agent works in (its working directory). */
  worktree: string;
  files: readonly DigestFile[];
  /** The digest left files out. */
  truncated?: boolean | undefined;
}

export interface AgentFileChange {
  /** The path inside its checkout. */
  path: string;
  added: number | null;
  removed: number | null;
  /** Another agent changed the same file in the same checkout. */
  shared: boolean;
}

export interface AgentChanges {
  agentId: string;
  files: AgentFileChange[];
  truncated: boolean;
}

export interface WorktreeChanges {
  worktree: string;
  agents: AgentChanges[];
}

export interface FileConflict {
  worktree: string;
  path: string;
  /** The agents' ids, in the order they appear. */
  agents: string[];
}

export interface ChangesByAgent {
  worktrees: WorktreeChanges[];
  conflicts: FileConflict[];
}

const trimEnd = (path: string) => (path.length > 1 ? path.replace(/[/\\]+$/, "") : path);

/** A path relative to its checkout, so an absolute and a relative report of one file agree. */
export function pathInWorktree(path: string, worktree: string): string {
  const root = trimEnd(worktree);
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.replace(/^\.\//, "");
}

/**
 * Agents' changed files grouped by checkout (in first-seen order), agents without changes left
 * out, and every file more than one agent changed in the same checkout flagged on each of them.
 */
export function changesByAgent(input: readonly AgentFiles[]): ChangesByAgent {
  const worktrees = new Map<string, AgentChanges[]>();
  const owners = new Map<string, Map<string, string[]>>();
  for (const agent of input) {
    if (!agent.files.length) continue;
    const worktree = trimEnd(agent.worktree);
    const seen = new Set<string>();
    const files: AgentFileChange[] = [];
    let paths = owners.get(worktree);
    if (!paths) owners.set(worktree, (paths = new Map()));
    for (const file of agent.files) {
      const path = pathInWorktree(file.path, worktree);
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({ path, added: file.added, removed: file.removed, shared: false });
      const names = paths.get(path) ?? [];
      if (!names.includes(agent.agentId)) names.push(agent.agentId);
      paths.set(path, names);
    }
    const group = worktrees.get(worktree) ?? [];
    group.push({ agentId: agent.agentId, files, truncated: !!agent.truncated });
    worktrees.set(worktree, group);
  }
  const conflicts: FileConflict[] = [];
  for (const [worktree, paths] of owners)
    for (const [path, agents] of paths)
      if (agents.length > 1) conflicts.push({ worktree, path, agents: [...agents] });
  for (const [worktree, agents] of worktrees) {
    const shared = owners.get(worktree);
    for (const agent of agents)
      for (const file of agent.files) file.shared = (shared?.get(file.path)?.length ?? 0) > 1;
  }
  return {
    worktrees: [...worktrees].map(([worktree, agents]) => ({ worktree, agents })),
    conflicts,
  };
}

/**
 * Each agent's share of a turn's changes, from the turn index: the main agent's own share, then
 * each subagent's, in the checkout it works in (`cwdOf`, else the thread's `fallback`).
 */
export function turnAgentFiles(
  turn: Pick<TurnSummary, "main" | "subagents">,
  cwdOf: (agentId: string) => string | undefined,
  fallback: string,
): AgentFiles[] {
  const shares = [...(turn.main ? [turn.main] : []), ...turn.subagents];
  return shares.map((share) => ({
    agentId: share.agentId,
    worktree: cwdOf(share.agentId) ?? fallback,
    files: share.digest.files,
    truncated: share.digest.truncated && share.digest.files.length >= 64,
  }));
}
