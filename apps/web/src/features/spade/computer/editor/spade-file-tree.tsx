import { formatBytes } from "@ace/ui-core/byte-size";
import { formatAgo } from "@ace/ui-core/time";
import { CaretRightIcon, DotsThreeIcon } from "@ace/icons";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { fileIcon, folderIcon } from "@/components/file-icon.ts";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { message } from "../../spade-screen-parts.tsx";
import { useSpadeClient } from "../../spade-machine.tsx";
import { readFolder, type SpadeFileEntry } from "../../spade-workspace-api.ts";

/** How a pick opens a file: a glance (the preview tab), kept, or in the pane to the side. */
export type OpenHow = "glance" | "keep" | "side";

/** What the tree needs from the file manager around it. */
export interface SpadeTree {
  bot: { id: string; name: string };
  /** The query key folders are read under: the file manager's, so a change reads them again. */
  folderKey(folder: string): readonly unknown[];
  expanded: ReadonlySet<string>;
  toggle(folder: string): void;
  /** The focused editor's file: its row is marked. */
  current: string | undefined;
  open(path: string, how: OpenHow): void;
  /** A row being renamed: its name field shows in its place. */
  renaming: string | undefined;
  onRenamed(from: string, to: string): void;
  /** The folder a new folder's name is typed in, while it is. */
  making: string | undefined;
  onMade(name: string): void;
  /** A row's ⋯ menu items. */
  menu(entry: SpadeFileEntry): ReactNode;
}

const rowClass =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm pr-8 text-left text-ui outline-none select-none transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset";
const indent = (depth: number) => ({ paddingLeft: 4 + depth * 12 });

/**
 * A bot's files as the code editor's explorer draws a checkout: folders open in place, a file
 * glances into the editor on a click and stays on a double-click (⌘-click opens it beside).
 * Each folder is read when opened, and again when the bot's stream says its files changed.
 */
export function SpadeFileTree(props: { tree: SpadeTree }) {
  return (
    <ul aria-label="Files" className="flex flex-col px-1 py-1">
      <FolderRows tree={props.tree} folder="" depth={0} />
    </ul>
  );
}

function FolderRows(props: { tree: SpadeTree; folder: string; depth: number }) {
  const { tree, folder, depth } = props;
  const client = useSpadeClient();
  const listing = useQuery({
    queryKey: tree.folderKey(folder),
    queryFn: ({ signal }) => readFolder(client, tree.bot.id, folder, { signal }),
  });
  const making =
    tree.making === folder ? (
      <li style={indent(depth)}>
        <NameField label="New folder name" initial="" onDone={tree.onMade} />
      </li>
    ) : null;
  if (listing.isPending)
    return (
      <li style={indent(depth)} className={cn(rowClass, "text-muted-foreground")}>
        <span aria-hidden className="size-4 shrink-0" />
        Loading…
      </li>
    );
  if (listing.isError)
    return (
      <li role="alert" style={indent(depth)} className={cn(rowClass, "text-muted-foreground")}>
        <span className="min-w-0 flex-1 truncate">{message(listing.error)}</span>
        <Button size="xs" variant="ghost" onClick={() => void listing.refetch()}>
          Try again
        </Button>
      </li>
    );
  const { entries, truncated } = listing.data;
  if (entries.length === 0 && !making)
    return (
      <li style={indent(depth + 1)} className="px-1 py-1 text-ui text-muted-foreground">
        {folder ? "Empty" : `${tree.bot.name} hasn't kept any files yet.`}
      </li>
    );
  return (
    <>
      {making}
      {entries.map((entry) => (
        <li key={entry.path}>
          {tree.renaming === entry.path ? (
            <div style={indent(depth)}>
              <NameField
                label={`New name or path for ${entry.name}`}
                initial={entry.path}
                onDone={(to) => tree.onRenamed(entry.path, to)}
              />
            </div>
          ) : (
            <Row tree={tree} entry={entry} depth={depth} />
          )}
          {entry.kind === "folder" && tree.expanded.has(entry.path) && (
            <ul role="group" aria-label={entry.name}>
              <FolderRows tree={tree} folder={entry.path} depth={depth + 1} />
            </ul>
          )}
        </li>
      ))}
      {truncated && (
        <li style={indent(depth + 1)} className="px-1 py-1 text-ui text-muted-foreground">
          Only the first {entries.length} are shown.
        </li>
      )}
    </>
  );
}

function Row(props: { tree: SpadeTree; entry: SpadeFileEntry; depth: number }) {
  const { tree, entry, depth } = props;
  const folder = entry.kind === "folder";
  const open = folder && tree.expanded.has(entry.path);
  const current = !folder && tree.current === entry.path;
  return (
    <div {...part("list-row", current && "selected", entry.kind)} className="group/file relative">
      <button
        type="button"
        aria-expanded={folder ? open : undefined}
        aria-current={current ? "true" : undefined}
        title={facts(entry)}
        style={indent(depth)}
        onClick={(event) => {
          if (folder) tree.toggle(entry.path);
          else tree.open(entry.path, event.metaKey || event.ctrlKey ? "side" : "glance");
        }}
        onDoubleClick={() => !folder && tree.open(entry.path, "keep")}
        className={cn(rowClass, "text-foreground", current && "bg-active")}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {folder && (
            <CaretRightIcon
              aria-hidden
              size={12}
              className={cn(
                "text-faint-foreground transition-transform duration-(--motion-fast)",
                open && "rotate-90",
              )}
            />
          )}
        </span>
        <Icon
          icon={folder ? folderIcon(entry.path, open) : fileIcon(entry.path)}
          size={16}
          className="shrink-0 text-subtle-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
      <span className="absolute inset-y-0 right-0.5 flex items-center">
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                icon={DotsThreeIcon}
                size="sm"
                label={`More for ${entry.name}`}
                className="size-6 rounded-sm opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
              />
            }
          />
          <MenuContent align="end">{tree.menu(entry)}</MenuContent>
        </Menu>
      </span>
    </div>
  );
}

/** A name typed in place: Enter keeps it, Esc or leaving the field drops it. */
export function NameField(props: { label: string; initial: string; onDone(value: string): void }) {
  const [value, setValue] = useState(props.initial);
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    props.onDone(keep ? value : "");
  };
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person just asked to type a name
      autoFocus
      aria-label={props.label}
      placeholder={props.label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(false)}
      className="my-px h-7 w-full rounded-sm bg-secondary px-2 text-ui text-foreground focus-ring"
    />
  );
}

/** A row's own facts, on hover: a file's size and age, a link as such. */
function facts(entry: SpadeFileEntry): string {
  if (entry.kind === "link") return `${entry.path} · Link`;
  const age = entry.modifiedAt === undefined ? undefined : formatAgo(entry.modifiedAt, Date.now());
  if (entry.kind === "folder") return age ? `${entry.path} · ${age}` : entry.path;
  const size = formatBytes(entry.size);
  return age ? `${entry.path} · ${size} · ${age}` : `${entry.path} · ${size}`;
}
