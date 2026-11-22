import { CaretRightIcon } from "@ace/icons";
import type { FileSearchFile, FileSearchLine } from "@ace/protocol";
import type { CSSProperties } from "react";
import { Icon } from "@/components/icon.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { cn } from "@/lib/cn.ts";
import { countedWords, matchCount, previewParts } from "@ace/ui-core";
import { MiddleName, MiddleText } from "./middle-name.tsx";

const count = (value: number) => value.toLocaleString();
const noPositions: readonly number[] = [];

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
      className="group/search flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-ui outline-none select-none transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <CaretRightIcon
          aria-hidden
          size={12}
          className={cn(
            "text-faint-foreground transition-[transform,color] duration-(--motion-fast) group-hover/search:text-subtle-foreground",
            open && "rotate-90",
          )}
        />
      </span>
      <Icon icon={fileIcon(file.path)} size={16} className="shrink-0 text-subtle-foreground" />
      {/* The name gives way only when it alone is wider than the row; the folder goes first. */}
      <MiddleName
        part="search-file-name"
        text={name}
        offset={0}
        positions={noPositions}
        className="text-foreground"
      />
      {/* Cut in its middle, its last folder kept: that tells two same-named files apart. */}
      <span className="flex min-w-0 flex-1 overflow-hidden">
        {folder && (
          <MiddleText
            text={folder}
            tail={folder.length - folder.lastIndexOf("/")}
            className="text-xs text-subtle-foreground"
          />
        )}
      </span>
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
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-7 text-left font-mono text-xs text-muted-foreground outline-none select-none transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset",
        props.current && "bg-active",
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
