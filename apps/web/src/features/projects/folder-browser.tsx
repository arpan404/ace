import {
  ArrowUpIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  HouseSimpleIcon,
  LockSimpleIcon,
  WifiSlashIcon,
} from "@phosphor-icons/react";
import { crumbs, folderName, formatAge, parentFolder } from "@ace/ui-core";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { projectFailure } from "./project-commands.ts";
import { useFolderListing } from "./use-folders.ts";

interface Entry {
  name: string;
  path: string;
  git: boolean;
  modifiedAt: number;
}

/**
 * The daemon host's folders, one at a time: a breadcrumb from the home folder, the folders
 * inside with a Git mark on repository roots, a page of 100 at a time, and hidden folders on
 * request. Click selects a folder, double-click or Enter opens it; arrows move, Backspace or
 * ← goes up. Every path is the daemon's: nothing here reads this computer's disk.
 */
export function FolderBrowser(props: {
  label: string;
  path: string | undefined;
  onPath(path: string): void;
  selected: string | undefined;
  onSelect(path: string | undefined): void;
  /** The host's home and allowed roots: the breadcrumb starts at home, Up stops at a root. */
  home: string | undefined;
  roots: readonly string[];
}) {
  const [showHidden, setShowHidden] = useState(false);
  const listing = useFolderListing(props.path, showHidden);
  const now = useNow();
  const listId = useId();
  const hiddenId = useId();
  const list = useRef<HTMLDivElement>(null);
  const entries = listing.entries ?? [];
  const parent = props.path ? parentFolder(props.path) : undefined;
  const atRoot = props.path !== undefined && props.roots.includes(props.path);
  const canGoUp = parent !== undefined && !atRoot;
  const selectedIndex = entries.findIndex((entry) => entry.path === props.selected);

  const open = (path: string) => {
    props.onPath(path);
    props.onSelect(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = (index: number) => {
      const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
      if (!entry) return;
      props.onSelect(entry.path);
      document.getElementById(`${listId}-${entries.indexOf(entry)}`)?.scrollIntoView?.({
        block: "nearest",
      });
    };
    const key = event.key;
    if (key === "ArrowDown") move(selectedIndex + 1);
    else if (key === "ArrowUp") move(selectedIndex < 0 ? entries.length - 1 : selectedIndex - 1);
    else if (key === "Home") move(0);
    else if (key === "End") move(entries.length - 1);
    else if ((key === "Enter" || key === "ArrowRight") && props.selected) open(props.selected);
    else if ((key === "Backspace" || key === "ArrowLeft") && canGoUp && parent) open(parent);
    else return;
    event.preventDefault();
  };

  const failure = listing.error ? projectFailure(listing.error) : undefined;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <IconButton
          icon={ArrowUpIcon}
          label="Up one folder"
          size="sm"
          disabled={!canGoUp}
          onClick={() => parent && open(parent)}
        />
        <nav aria-label="Folder path" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-0.5 overflow-hidden text-sm text-muted-foreground">
            {props.path &&
              crumbs(props.path, props.home).map((crumb, index, all) => (
                <li key={crumb.path} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && <span aria-hidden>/</span>}
                  <button
                    type="button"
                    aria-current={index === all.length - 1 ? "location" : undefined}
                    onClick={() => open(crumb.path)}
                    className="inline-flex h-[22px] min-w-0 items-center gap-1 rounded-[7px] px-1.5 outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent aria-[current]:text-foreground"
                  >
                    {crumb.home && <Icon icon={HouseSimpleIcon} size={13} />}
                    <span className="truncate">{crumb.label}</span>
                  </button>
                </li>
              ))}
          </ol>
        </nav>
        <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
          <Checkbox
            id={hiddenId}
            checked={showHidden}
            onCheckedChange={(checked) => setShowHidden(checked)}
          />
          <label htmlFor={hiddenId}>Hidden folders</label>
        </span>
      </div>
      <div className="h-64 overflow-y-auto rounded-md bg-secondary p-1">
        {listing.offline ? (
          <Notice icon={WifiSlashIcon} text="Reconnecting to the daemon…" />
        ) : listing.loading ? (
          <ListSkeleton label="folders" shape="row" rows={6} />
        ) : failure ? (
          <Notice
            icon={failure.denied ? LockSimpleIcon : FolderSimpleIcon}
            text={failure.message}
            action={
              failure.denied && props.home ? (
                <Button size="sm" onClick={() => props.home && open(props.home)}>
                  Go to the home folder
                </Button>
              ) : (
                <Button size="sm" onClick={listing.retry}>
                  Try again
                </Button>
              )
            }
          />
        ) : entries.length === 0 ? (
          <Notice
            icon={FolderSimpleIcon}
            text={
              showHidden
                ? `${props.path ? folderName(props.path) : "This folder"} has no folders inside.`
                : "No folders here. Hidden folders aren't shown."
            }
          />
        ) : (
          <div
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={0}
            aria-label={props.label}
            aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
            onKeyDown={onKeyDown}
            className="rounded-[7px] outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)]"
          >
            {entries.map((entry, index) => (
              <FolderRow
                key={entry.path}
                id={`${listId}-${index}`}
                entry={entry}
                now={now}
                selected={entry.path === props.selected}
                onSelect={() => {
                  props.onSelect(entry.path);
                  list.current?.focus();
                }}
                onOpen={() => open(entry.path)}
              />
            ))}
            {listing.more && (
              <div className="p-1">
                <Button size="sm" variant="ghost" onClick={listing.loadMore}>
                  {listing.loadingMore ? "Loading…" : "Show more folders"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FolderRow(props: {
  id: string;
  entry: Entry;
  now: number;
  selected: boolean;
  onSelect(): void;
  onOpen(): void;
}) {
  const { entry } = props;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
      className={cn(
        "flex h-[30px] cursor-default items-center gap-2 rounded-[7px] px-2 text-ui text-foreground",
        props.selected ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <Icon icon={FolderSimpleIcon} size={14} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.git && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Icon icon={GitBranchIcon} size={12} />
          Git
        </span>
      )}
      <span className="w-8 text-right text-xs text-subtle-foreground tabular-nums">
        {formatAge(entry.modifiedAt, props.now)}
      </span>
    </div>
  );
}

function Notice(props: { icon: typeof FolderSimpleIcon; text: string; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-ui text-muted-foreground"
    >
      <Icon icon={props.icon} size={20} />
      <p className="max-w-[44ch]">{props.text}</p>
      {props.action}
    </div>
  );
}
