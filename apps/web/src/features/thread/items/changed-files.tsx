import { Button } from "@/components/ui/button.tsx";
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
    return <span className="font-mono text-[12px] text-subtle-foreground">±…</span>;
  return (
    <span className="font-mono text-[12px]">
      <span className="text-status-done">+{props.added}</span>{" "}
      <span className="text-status-failed">−{props.removed}</span>
    </span>
  );
}

/** The files a turn changed, with the diff stat. "Open diff" shows the Changes tab. */
export function ChangedFiles(props: { threadId: string; itemIds: readonly string[] }) {
  const edits = useItemsSelect(props.threadId, props.itemIds, selectEdits, sameEdits) ?? none;
  const files = useFileStats(edits);
  const workspace = useWorkspaceActions(props.threadId);
  if (!files.length) return null;
  const counted = files.every((file) => file.stat);
  const added = counted ? files.reduce((sum, file) => sum + (file.stat?.added ?? 0), 0) : undefined;
  const removed = counted
    ? files.reduce((sum, file) => sum + (file.stat?.removed ?? 0), 0)
    : undefined;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 px-0 text-muted-foreground"
      onClick={() => workspace.open({ kind: "changes" })}
    >
      Changed {files.length} {files.length === 1 ? "file" : "files"}{" "}
      <Stat added={added} removed={removed} /> ›
    </Button>
  );
}
