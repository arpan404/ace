import { FileCodeIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useLayout } from "@/lib/layout.tsx";
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
  const [open, setOpen] = useState(false);
  const { setPanelOpen, setTab } = useLayout();
  const list = useId();
  if (!files.length) return null;
  const counted = files.every((file) => file.stat);
  const added = counted ? files.reduce((sum, file) => sum + (file.stat?.added ?? 0), 0) : undefined;
  const removed = counted
    ? files.reduce((sum, file) => sum + (file.stat?.removed ?? 0), 0)
    : undefined;
  const label = `${files.length} changed ${files.length === 1 ? "file" : "files"}`;
  return (
    <section aria-label={label}>
      {/* On a narrow column the actions wrap under the label instead of squeezing it. */}
      <div className="flex min-h-[42px] flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-card py-1 pr-2 pl-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="flex items-center gap-2.5 whitespace-nowrap">
          <span className="text-[13.5px] font-medium">{label}</span>
          <Stat added={added} removed={removed} />
        </span>
        <span className="flex flex-1 justify-end">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={list}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide files" : "Show files"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTab("right", "changes");
              setPanelOpen("right", true);
            }}
          >
            Open diff
          </Button>
        </span>
      </div>
      {open && (
        <ul id={list} className="mt-2 flex flex-col border-l-2 py-1 pl-2.5">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex h-7 items-center gap-2 px-1.5 text-ui text-muted-foreground"
            >
              <FileCodeIcon aria-hidden size={14} className="text-subtle-foreground" />
              <code className="min-w-0 truncate font-mono text-[12px] text-foreground">
                {file.path}
              </code>
              <span className="ml-auto">
                <Stat added={file.stat?.added} removed={file.stat?.removed} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
