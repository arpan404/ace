import { useState, type DragEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { useAgentMark, useSnapshot, type DeckBuffers } from "./deck-buffers.ts";
import { writeTabDrag } from "./drag.ts";
import type { EditorTab } from "@ace/ui-core/editor-workbench";
import { fileName } from "./paths.ts";
import { slotShows, TabSlot } from "./tab-slot.tsx";

/**
 * One editor tab: the file's name (italic while it is a preview), the nearest telling folder
 * when two tabs share a name, and the one slot. Click shows it; double-click keeps a preview;
 * middle-click closes; drag moves it to another strip or a group's edge.
 */
export function DeckTabView(props: {
  group: string;
  tab: EditorTab;
  hint: string | undefined;
  active: boolean;
  /** The tab's group is the focused one: its active tab reads in full ink. */
  groupFocused: boolean;
  /** This tab holds the strip's single tab stop. */
  focusable: boolean;
  buffers: DeckBuffers;
  onActivate(): void;
  onKeep(): void;
  onClose(): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onDragOver(event: DragEvent<HTMLElement>, after: boolean): void;
}) {
  const { tab } = props;
  const unsaved = useSnapshot(props.buffers, tab.path)?.dirty ?? false;
  const mark = useAgentMark(props.buffers, tab.path);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const name = fileName(tab.path);
  const shows = slotShows(
    unsaved,
    tab.pinned,
    hovered || focused || props.active,
    hovered,
    mark !== undefined,
  );
  return (
    <div
      role="tab"
      aria-selected={props.active}
      tabIndex={props.focusable ? 0 : -1}
      title={mark ? `${tab.path}, changed by ${mark.name}` : tab.path}
      data-path={tab.path}
      data-preview={tab.preview ? "" : undefined}
      aria-description={tab.preview ? "Preview" : undefined}
      draggable
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={props.onActivate}
      onDoubleClick={() => {
        if (tab.preview) props.onKeep();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose();
      }}
      onMouseDown={(event) => {
        // Middle-click must not start the browser's autoscroll over the strip.
        if (event.button === 1) event.preventDefault();
      }}
      onKeyDown={props.onKeyDown}
      onDragStart={(event) =>
        writeTabDrag(event.dataTransfer, { group: props.group, path: tab.path })
      }
      onDragOver={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        props.onDragOver(event, event.clientX > box.left + box.width / 2);
      }}
      className={cn(
        "flex h-7 shrink-0 cursor-default items-center gap-1 rounded-sm pr-1 pl-2.5 text-ui whitespace-nowrap select-none focus-ring-inset",
        "text-subtle-foreground transition-[background-color,color] duration-(--motion-fast) hover:text-foreground",
        props.active
          ? cn("bg-active", props.groupFocused ? "text-foreground" : "text-muted-foreground")
          : "hover:bg-hover",
      )}
    >
      <span data-tab-title className={cn("max-w-[180px] truncate", tab.preview && "italic")}>
        {name}
      </span>
      {props.hint && <span className="text-xs text-subtle-foreground">· {props.hint}</span>}
      <TabSlot
        shows={shows}
        unsaved={unsaved}
        name={name}
        provider={mark?.provider}
        onClose={props.onClose}
      />
    </div>
  );
}
