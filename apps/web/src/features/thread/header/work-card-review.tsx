import { useThreadField } from "@ace/client-react/thread-field";
import { groupFileChanges } from "@ace/ui-core";
import { workspaceRelative } from "@ace/ui-core/file-references";
import { NotePencilIcon } from "@ace/icons";
import { useMemo } from "react";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import { threadCheckoutRoot } from "@/lib/thread-fields.ts";
import { useReviewInEditor } from "@/lib/workspace/index.ts";
import { RowButton, RowLabel, RowSub, rowIcon } from "./work-card-parts.tsx";

/**
 * The thread's last turn that changed files, to review inside the editor: its hunks inline, file
 * after file, to keep, revert or comment on. Absent until a turn has changed a file.
 */
export function ReviewTurnRow(props: { threadId: string; onClose(): void }) {
  const turns = useTurns(props.threadId);
  const checkout = useThreadField(props.threadId, threadCheckoutRoot);
  const review = useReviewInEditor(props.threadId);
  const last = turns.findLast((turn) => turn.edits.length > 0);
  const paths = useMemo(
    () =>
      last
        ? groupFileChanges(last.edits).flatMap((file) => {
            const path = workspaceRelative(file.path, checkout);
            return path === undefined ? [] : [path];
          })
        : [],
    [last, checkout],
  );
  const first = paths[0];
  if (!last || first === undefined) return null;
  return (
    <RowButton
      onClick={() => {
        review(first, last.id);
        props.onClose();
      }}
    >
      <NotePencilIcon aria-hidden size={16} className={rowIcon} />
      <RowLabel>Review turn {last.number} in editor</RowLabel>
      <RowSub className="shrink-0">
        {paths.length === 1 ? "1 file" : `${paths.length} files`}
      </RowSub>
    </RowButton>
  );
}
