import { TerminalWindowIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";

/** Terminal tab of the bottom panel. TODO(terminal slice): terminal tabs on xterm.js. */
export function TerminalPanel(_props: { threadId: string }) {
  return (
    <EmptyState
      icon={TerminalWindowIcon}
      title="No terminals"
      description="Open a terminal in this thread's worktree, or watch the agents' background shells."
    />
  );
}

/** Logs tab of the bottom panel. TODO(terminal slice): daemon and provider logs. */
export function LogsPanel(_props: { threadId: string }) {
  return (
    <EmptyState
      icon={TerminalWindowIcon}
      title="No logs yet"
      description="Provider and daemon output for this thread appears here."
    />
  );
}
