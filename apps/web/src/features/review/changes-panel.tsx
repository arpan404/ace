import { GitDiffIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";

/**
 * Changes tab of the thread's right panel. TODO(review slice): per-turn diff, unified/split,
 * folds, line comments with "Send to agent".
 */
export function ChangesPanel(_props: { threadId: string }) {
  return (
    <EmptyState
      icon={GitDiffIcon}
      title="No changes yet"
      description="Edits the agents make in this thread show up here, turn by turn."
    />
  );
}
