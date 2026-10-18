import { WarningIcon } from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { cn } from "@/lib/cn.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { capsule } from "../agents/task-capsule.tsx";

/**
 * One changed file in the Summary: its path, its `+N −M` and, when another agent changed it in
 * the same checkout, a warning. A click opens Changes on the latest turn with the file in view.
 */
export function FileRow(props: {
  threadId: string;
  path: string;
  added: number | null;
  removed: number | null;
  shared?: boolean | undefined;
}) {
  const workspace = useWorkspaceActions(props.threadId);
  const name = props.path.split("/").at(-1) ?? props.path;
  const folder = props.path.slice(0, props.path.length - name.length);
  return (
    <li>
      <button
        type="button"
        title={props.path}
        aria-label={`${props.path}${props.shared ? ", also changed by another agent" : ""}`}
        onClick={() =>
          workspace.open({ kind: "changes", data: { scope: "last", path: props.path } })
        }
        className={cn(
          "focus-ring-inset flex h-7 w-full min-w-0 items-center gap-2 pr-2 pl-2 text-left font-mono text-xs",
          capsule,
        )}
      >
        {props.shared && (
          <WarningIcon
            aria-hidden
            size={12}
            data-tone="needs-you"
            className="shrink-0 text-(--tone-text)"
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-subtle-foreground">{folder}</span>
          {name}
        </span>
        {props.added !== null && props.removed !== null && (
          <DiffStat additions={props.added} deletions={props.removed} className="shrink-0" />
        )}
      </button>
    </li>
  );
}
