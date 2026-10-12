import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { fileChanges, type Turn } from "@ace/ui-core";
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

/** Chips shown before the rest fold into "+N more". */
const shown = 4;
const chip =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-md bg-fill px-2 font-mono text-xs text-foreground transition-colors duration-(--motion-fast) hover:bg-fill-strong focus-ring";

/**
 * The files a turn changed, as wrapping chips: each file's name with its `+N −M`, then "+2 more".
 * Any chip opens the turn's changes in the Changes tab.
 */
export function ChangedFiles(props: { threadId: string; itemIds: readonly string[] }) {
  const edits = useItemsSelect(props.threadId, props.itemIds, selectEdits, sameEdits) ?? none;
  const files = useFileStats(edits);
  const workspace = useWorkspaceActions(props.threadId);
  if (!files.length) return null;
  const open = () => workspace.open({ kind: "changes" });
  const label = `Changed ${files.length} ${files.length === 1 ? "file" : "files"}`;
  const rest = files.length - shown;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {files.slice(0, rest === 1 ? files.length : shown).map((file) => (
        <button
          key={file.path}
          type="button"
          title={file.path}
          aria-label={`${file.path} ${file.stat ? `+${file.stat.added} −${file.stat.removed}` : ""}`}
          onClick={open}
          className={chip}
        >
          <span className="min-w-0 truncate">{file.path.split("/").at(-1) ?? file.path}</span>
          <Stat added={file.stat?.added} removed={file.stat?.removed} />
        </button>
      ))}
      {rest > 1 && (
        <button
          type="button"
          onClick={open}
          className="h-7 px-1 font-mono text-xs text-subtle-foreground transition-colors duration-(--motion-fast) hover:text-foreground focus-ring"
        >
          +{rest} more
        </button>
      )}
    </div>
  );
}
