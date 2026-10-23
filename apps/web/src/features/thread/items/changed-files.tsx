import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { changedFileChips, fileChanges, fileChipName, rootRunOf, type Turn } from "@ace/ui-core";
import { useCallback } from "react";
import type { Item } from "@ace/protocol";
import { useFileStats } from "@/lib/diffs/use-file-diffs.ts";
import { useItemsSelect } from "../lib/use-items.ts";

type Edits = Turn["edits"];
const none: Edits = [];
/** The edit tool calls among a turn's items. Store items are immutable, so identity compares. */
const selectEdits = (items: readonly (Item | undefined)[]): Edits => {
  const edits = items.filter(
    (item): item is Edits[number] => item?.type === "tool_call" && fileChanges(item).length > 0,
  );
  return edits.length ? edits : none;
};
const sameEdits = (a: Edits, b: Edits) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

function Stat(props: { added: number | undefined; removed: number | undefined }) {
  // Until the diff worker has counted a full-text edit, the stat keeps its place quietly.
  if (props.added === undefined || props.removed === undefined)
    return <span className="text-subtle-foreground">±…</span>;
  return (
    <span>
      <span className="text-status-done">+{props.added}</span>{" "}
      <span className="text-status-failed">−{props.removed}</span>
    </span>
  );
}

const chip =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-md bg-fill px-2 font-mono text-xs text-foreground transition-colors duration-(--motion-fast) hover:bg-fill-strong focus-ring";

/**
 * The files a turn changed, as wrapping chips: each file's name with its `+N −M`, then "+2 more".
 * A chip opens Changes on that turn with its file in view; "+N more" opens the turn's changes.
 */
export function ChangedFiles(props: { threadId: string; itemIds: readonly string[] }) {
  const edits = useItemsSelect(props.threadId, props.itemIds, selectEdits, sameEdits) ?? none;
  const files = useFileStats(edits);
  const workspace = useWorkspaceActions(props.threadId);
  const first = props.itemIds[0] ?? "";
  // The root turn the edits belong to (a subagent's edits count toward the turn that spawned it).
  const readTurn = useCallback(
    (reader: ThreadReader) => rootRunOf(reader, reader.item(first)?.runId)?.id,
    [first],
  );
  const turn = useThread(props.threadId, [`item:${first}`, "agents"], readTurn, Object.is);
  if (!files.length) return null;
  const scope = turn ? { scope: turn } : {};
  const open = (path?: string) =>
    workspace.open({ kind: "changes", data: path ? { ...scope, path } : scope });
  const { chips, more, label } = changedFileChips(files);
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {chips.map((file) => (
        <button
          key={file.path}
          type="button"
          title={file.path}
          aria-label={`${file.path} ${file.stat ? `+${file.stat.added} −${file.stat.removed}` : ""}`}
          onClick={() => open(file.path)}
          className={chip}
        >
          <span className="min-w-0 truncate">{fileChipName(file.path)}</span>
          <Stat added={file.stat?.added} removed={file.stat?.removed} />
        </button>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => open()}
          className="h-7 px-1 font-mono text-xs text-subtle-foreground transition-colors duration-(--motion-fast) hover:text-foreground focus-ring"
        >
          +{more} more
        </button>
      )}
    </div>
  );
}
