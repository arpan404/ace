import { FileCodeIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { summarizeChanges } from "@ace/ui-core";
import { useItemsSelect } from "../lib/use-items.ts";

type Files = ReturnType<typeof summarizeChanges>;
const filesEqual = (a: Files, b: Files) =>
  a.length === b.length &&
  a.every((file, index) => {
    const other = b[index];
    return (
      !!other &&
      other.path === file.path &&
      other.stat.added === file.stat.added &&
      other.stat.removed === file.stat.removed
    );
  });

function Stat(props: { added: number; removed: number }) {
  return (
    <span className="font-mono text-[12px]">
      <span className="text-status-done">+{props.added}</span>{" "}
      <span className="text-status-failed">−{props.removed}</span>
    </span>
  );
}

/** The files a turn changed, with the diff stat. "Open diff" shows the Changes tab. */
export function ChangedFiles(props: { threadId: string; itemIds: readonly string[] }) {
  const files = useItemsSelect(props.threadId, props.itemIds, summarizeChanges, filesEqual);
  const [open, setOpen] = useState(false);
  const { setPanelOpen, setTab } = useLayout();
  const list = useId();
  if (!files?.length) return null;
  const added = files.reduce((sum, file) => sum + file.stat.added, 0);
  const removed = files.reduce((sum, file) => sum + file.stat.removed, 0);
  const label = `${files.length} changed ${files.length === 1 ? "file" : "files"}`;
  return (
    <section aria-label={label}>
      <div className="flex h-[42px] items-center gap-2.5 rounded-card pr-2 pl-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="text-[13.5px] font-medium">{label}</span>
        <Stat added={added} removed={removed} />
        <span className="flex-1" />
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
                <Stat added={file.stat.added} removed={file.stat.removed} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
