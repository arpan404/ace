import {
  findTab,
  type OpenTab,
  type ScopeWorkspace,
  type WorkspaceActions,
} from "@/lib/workspace/index.ts";

/*
 * How terminals and agent shells are named as workspace tabs. Loaded with the thread screen
 * (the header's Run and the palette open terminals), so it carries no code beyond strings.
 *
 * - `terminal:<pty id>`: one of your PTYs. Closing the tab ends its shell.
 * - `terminal` (id "terminal"): a terminal about to start that first picks up a running shell
 *   of the thread that no tab shows, else opens one. The launcher, ⌃` and ⌘J open this.
 * - `terminal:pending-<n>`: a terminal about to start that always opens a new shell (New
 *   terminal).
 * - `shell:<task id>`: an agent's background shell, read-only. Closing the tab only stops
 *   showing it; the agent's shell keeps running.
 */

export const terminalKind = "terminal";
export const shellKind = "shell";
const pendingPrefix = "pending-";

/** A terminal tab with no shell yet. */
export const isPendingTerminal = (id: string): boolean =>
  id === terminalKind || id.startsWith(pendingPrefix);

/** A terminal tab that should pick up a shell no tab shows before opening a new one. */
export const reusesSpareShell = (id: string): boolean => id === terminalKind;

/** A new terminal, always with a shell of its own. */
export function newTerminal(workspace: ScopeWorkspace): OpenTab {
  const taken = workspace.tabs
    .filter((tab) => tab.kind === terminalKind && tab.id.startsWith(pendingPrefix))
    .map((tab) => Number(tab.id.slice(pendingPrefix.length)) || 0);
  return { kind: terminalKind, id: `${pendingPrefix}${Math.max(0, ...taken) + 1}` };
}

/**
 * New terminal: a shell of its own. The panel's waiting `terminal` tab becomes it if
 * that tab hasn't started a shell yet, so the strip never shows two tabs called Terminal.
 */
export function openNewTerminal(
  actions: Pick<WorkspaceActions, "open" | "replace">,
  workspace: ScopeWorkspace,
): void {
  const fresh = newTerminal(workspace);
  const waiting = findTab(workspace, terminalKind);
  if (waiting) actions.replace(waiting.tab.key, { ...fresh, pinned: waiting.tab.pinned });
  else actions.open(fresh);
}

/** The tab of a PTY the daemon already runs (a script run, a shell opened elsewhere). */
export const terminalTab = (terminal: { id: string; name: string }): OpenTab => ({
  kind: terminalKind,
  id: terminal.id,
  title: terminal.name,
});

/** The tab of an agent's background shell. */
export const shellTab = (task: { id: string; title: string }): OpenTab => ({
  kind: shellKind,
  id: task.id,
  title: shellLabel(task.title),
});

/** "bun run dev:relay" → "dev:relay"; "cargo watch -x test" → "cargo". */
export function shellLabel(command: string): string {
  const script = /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(\S+)/.exec(command.trim());
  if (script?.[1]) return script[1];
  return command.trim().split(/\s+/)[0]?.split("/").pop() || command;
}

/** Ids of the PTYs a scope's tabs show. */
export function openTerminalIds(workspace: ScopeWorkspace): Set<string> {
  return new Set(
    workspace.tabs
      .filter((tab) => tab.kind === terminalKind && !isPendingTerminal(tab.id))
      .map((tab) => tab.id),
  );
}

/**
 * The shell a `terminal` tab picks up: the newest of the thread's running PTYs that no tab
 * shows (one opened before a reload, or on another window), if any.
 */
export function spareShell<T extends { id: string; exited: boolean }>(
  terminals: readonly T[],
  open: ReadonlySet<string>,
): T | undefined {
  return terminals.findLast((terminal) => !terminal.exited && !open.has(terminal.id));
}
