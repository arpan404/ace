import { CaretRightIcon } from "@ace/icons";
import type { FileSearchFile, FileSearchLine } from "@ace/protocol";
import type { CSSProperties } from "react";
import { Icon } from "@/components/icon.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { cn } from "@/lib/cn.ts";
import { countedWords, matchCount, previewParts } from "@ace/ui-core";

const count = (value: number) => value.toLocaleString();

/** A preview line trimmed so its first match shows, every match marked. */
function Preview(props: { line: FileSearchLine }) {
  const parts = previewParts(props.line.preview, props.line.ranges, props.line.column > 0);
  return (
    <span className="min-w-0 truncate whitespace-pre">
      {parts.map((part) =>
        part.match ? (
          <mark key={part.at} className="rounded-xs bg-foreground/18 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={part.at}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * A folder path cut in its middle when there is no room: its start and its last folder stay,
 * since the last folder is what tells two same-named files apart.
 */
function MiddlePath(props: { folder: string }) {
  const slash = props.folder.lastIndexOf("/");
  const head = slash > 0 ? props.folder.slice(0, slash) : "";
  const tail = slash > 0 ? props.folder.slice(slash) : props.folder;
  return (
    <span className="ml-1.5 flex min-w-0 flex-1 text-xs text-subtle-foreground">
      {head && <span className="min-w-0 truncate">{head}</span>}
      <span className={cn("whitespace-pre", head ? "shrink-0" : "min-w-0 truncate")}>{tail}</span>
    </span>
  );
}

/** A file's row: its whole name, then its folder dimmed, then its count at the right. */
export function FileRow(props: { file: FileSearchFile; open: boolean; onToggle(): void }) {
  const { file, open } = props;
  const matches = matchCount(file);
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash > 0 ? file.path.slice(0, slash) : "";
  return (
    <button
      type="button"
      data-search-row
      aria-expanded={open}
      aria-label={`${file.path}, ${countedWords(matches, "result", "results")}`}
      title={file.path}
      onClick={props.onToggle}
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-ui outline-none select-none hover:bg-accent focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)]"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <CaretRightIcon
          aria-hidden
          size={10}
          className={cn(
            "text-subtle-foreground transition-transform duration-(--motion-fast)",
            open && "rotate-90",
          )}
        />
      </span>
      <Icon icon={fileIcon(file.path)} size={14} className="shrink-0 text-subtle-foreground" />
      {/* The name gives way only when it alone is wider than the row. */}
      <span data-part="search-file-name" className="min-w-0 shrink-0 truncate text-foreground">
        {name}
      </span>
      {folder ? <MiddlePath folder={folder} /> : <span className="flex-1" />}
      <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">{count(matches)}</span>
    </button>
  );
}

/** A matching line: its number in a column as wide as the longest number, then its preview. */
export function LineRow(props: {
  path: string;
  line: FileSearchLine;
  /** The hit last opened, where F4 steps from. */
  current: boolean;
  /** Characters the widest line number needs. */
  digits: number;
  onOpen(keep: boolean): void;
}) {
  const { line } = props;
  const width: CSSProperties = { width: `${props.digits}ch` };
  return (
    <button
      type="button"
      data-search-row
      aria-label={`${props.path} line ${line.line}: ${line.preview.trim()}`}
      aria-current={props.current || undefined}
      title={`${props.path}:${line.line}`}
      onClick={(event) => props.onOpen(event.detail > 1)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        props.onOpen(true);
      }}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-7 text-left font-mono text-xs text-muted-foreground outline-none select-none hover:bg-accent focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)]",
        props.current && "bg-sidebar-accent",
      )}
    >
      <span
        style={width}
        className="shrink-0 text-right text-subtle-foreground tabular-nums"
        data-part="search-line-number"
      >
        {line.line}
      </span>
      <Preview line={line} />
    </button>
  );
}
