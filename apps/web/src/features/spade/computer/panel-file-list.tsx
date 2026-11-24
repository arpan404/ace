import { formatAge } from "@ace/ui-core/time";
import { CaretRightIcon, DotsThreeIcon, MagnifyingGlassIcon, XIcon } from "@ace/icons";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { fileIcon, folderIcon } from "@/components/file-icon.ts";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { useNow } from "@/lib/time.ts";
import { useSpadeClient } from "../spade-machine.tsx";
import {
  ProfileCardSkeleton,
  ProfileNone,
  ProfileProblem,
  rowPill,
} from "../spade-profile-parts.tsx";
import { readFolder, type SpadeFileEntry } from "../spade-workspace-api.ts";
import { NameField } from "./editor/spade-file-tree.tsx";

/**
 * Single-level file list for the narrow side panel: search at top, then one folder's entries as
 * calm rounded rows (small icon, name, modified age, row actions). Folders drill in one level at
 * a time; files open alone in the reader.
 */
export function PanelFileList(props: {
  bot: { id: string; name: string };
  folder: string;
  folderKey(folder: string): readonly unknown[];
  onOpenFolder(path: string): void;
  onOpenFile(path: string): void;
  writable: boolean;
  onUpload(): void;
  renaming: string | undefined;
  onRenamed(from: string, to: string): void;
  making: string | undefined;
  onMade(name: string): void;
  menu(entry: SpadeFileEntry): ReactNode;
  className?: string | undefined;
}) {
  const { bot, folder } = props;
  const client = useSpadeClient();
  const now = useNow();
  const [query, setQuery] = useState("");
  const listing = useQuery({
    queryKey: props.folderKey(folder),
    queryFn: ({ signal }) => readFolder(client, bot.id, folder, { signal }),
  });

  const entries = listing.data?.entries ?? [];
  const truncated = listing.data?.truncated === true;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle),
      )
    : entries;
  const makingHere = props.making === folder;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", props.className)}>
      <div className="shrink-0 px-4 pt-1 pb-3">
        <div className="flex h-9 items-center gap-2 rounded-xl bg-surface-1 px-3 shadow-[inset_0_0_0_1px_var(--border-soft)] transition-shadow duration-(--motion-fast) focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
          <Icon
            icon={MagnifyingGlassIcon}
            size={16}
            className="shrink-0 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Search files"
            placeholder="Search files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring"
            >
              <Icon icon={XIcon} size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {listing.isPending ? (
          <ProfileCardSkeleton card label="files" rows={4} />
        ) : listing.isError ? (
          <ProfileProblem
            card
            text="Couldn't read the files."
            onRetry={() => void listing.refetch()}
          />
        ) : shown.length === 0 && !makingHere ? (
          needle ? (
            <ProfileNone
              action={
                <Button size="sm" variant="ghost" className={rowPill} onClick={() => setQuery("")}>
                  Clear search
                </Button>
              }
            >
              {`No files matching “${query.trim()}”.`}
            </ProfileNone>
          ) : (
            <ProfileNone
              action={
                props.writable ? (
                  <Button size="sm" variant="ghost" className={rowPill} onClick={props.onUpload}>
                    Upload
                  </Button>
                ) : undefined
              }
            >
              {folder ? "This folder is empty." : `${bot.name} hasn't kept any files yet.`}
            </ProfileNone>
          )
        ) : (
          <>
            <ul
              aria-label="Files"
              className="divide-y divide-border-soft overflow-hidden rounded-xl bg-surface-1 shadow-[inset_0_0_0_1px_var(--border-soft)]"
            >
              {makingHere && (
                <li className="px-3.5 py-2">
                  <NameField label="New folder name" initial="" onDone={props.onMade} />
                </li>
              )}
              {shown.map((entry) => (
                <li key={entry.path}>
                  {props.renaming === entry.path ? (
                    <div className="px-3.5 py-2">
                      <NameField
                        label={`New name or path for ${entry.name}`}
                        initial={entry.path}
                        onDone={(to) => props.onRenamed(entry.path, to)}
                      />
                    </div>
                  ) : (
                    <PanelFileRow
                      entry={entry}
                      now={now}
                      onOpen={() =>
                        entry.kind === "folder"
                          ? props.onOpenFolder(entry.path)
                          : props.onOpenFile(entry.path)
                      }
                      menu={props.menu(entry)}
                    />
                  )}
                </li>
              ))}
            </ul>
            {truncated && (
              <p className="mt-2 px-1 text-xs text-muted-foreground">
                Only the first {entries.length} are shown.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PanelFileRow(props: {
  entry: SpadeFileEntry;
  now: number;
  onOpen(): void;
  menu: ReactNode;
}) {
  const { entry, now } = props;
  const folder = entry.kind === "folder";
  return (
    <div
      {...part("list-row", undefined, entry.kind)}
      className="group/file relative flex min-h-11 items-center transition-colors duration-(--motion-fast) hover:bg-hover"
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5 text-left outline-none select-none focus-ring-inset"
      >
        <Icon
          icon={folder ? folderIcon(entry.path, false) : fileIcon(entry.path)}
          size={16}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
          {entry.name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 transition-opacity duration-(--motion-fast) group-hover/file:opacity-0 group-focus-within/file:opacity-0">
          {entry.modifiedAt !== undefined && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatAge(entry.modifiedAt, now)}
            </span>
          )}
          {folder && (
            <Icon icon={CaretRightIcon} size={16} className="text-faint-foreground" />
          )}
        </span>
      </button>
      <span className="absolute inset-y-0 right-2 flex items-center">
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                icon={DotsThreeIcon}
                size="sm"
                label={`More for ${entry.name}`}
                className="size-7 rounded-full text-muted-foreground opacity-0 transition-opacity duration-(--motion-fast) group-hover/file:opacity-100 group-focus-within/file:opacity-100 hover:bg-active hover:text-foreground data-popup-open:opacity-100 pointer-coarse:opacity-100"
              />
            }
          />
          <MenuContent align="end">{props.menu}</MenuContent>
        </Menu>
      </span>
    </div>
  );
}
