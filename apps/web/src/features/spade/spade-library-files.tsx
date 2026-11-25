import { formatAge } from "@ace/ui-core/time";
import { CaretRightIcon } from "@ace/icons";
import type { SpadeFileEntry } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { part } from "@/lib/suit-part.ts";
import { FileThumb } from "./computer/file-thumb.tsx";
import type { FilesAt } from "./computer/profile-computer.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import {
  ProfileCard,
  ProfileCardSkeleton,
  ProfileNone,
  ProfileProblem,
  ProfileSection,
  profileRowClass,
  rowPill,
} from "./spade-profile-parts.tsx";
import { readFolder } from "./spade-workspace-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Files shown before All files. */
const shownFiles = 12;
const week = 7 * 24 * 60 * 60 * 1000;

export type LibraryFilesFilter = "all" | "bot" | "downloads" | "you";

const filterOptions: readonly { id: LibraryFilesFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bot", label: "Made by the bot" },
  { id: "downloads", label: "Downloads" },
  { id: "you", label: "From you" },
];

const downloadFolders = new Set(["downloads", "download", "web"]);
const fromYouFolders = new Set(["attachments", "uploads", "from-you"]);

/** What `entries` are, newest first, split at a week: Recent and Older, each only if it has any. */
export function filesByAge(entries: readonly SpadeFileEntry[], now: number) {
  const sorted = entries.toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  const recent = sorted.filter(
    (entry) => entry.modifiedAt !== undefined && now - entry.modifiedAt < week,
  );
  const older = sorted.filter((entry) => !recent.includes(entry));
  return [
    { label: "Recent", entries: recent },
    { label: "Older", entries: older },
  ].filter((group) => group.entries.length > 0);
}

/** Filters root entries for `Made by the bot` (excluding download and person-upload folders). */
export function filterLibraryFiles(
  entries: readonly SpadeFileEntry[],
  filter: LibraryFilesFilter,
): SpadeFileEntry[] {
  if (filter === "bot") {
    return entries.filter((entry) => {
      const top = entry.name.toLowerCase();
      return !downloadFolders.has(top) && !fromYouFolders.has(top);
    });
  }
  return [...entries];
}

const folderOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/**
 * The top of its workspace, newest kept first, grouped Recent and Older, with simple source
 * filters (All, Made by the bot, Downloads, From you); a file or folder opens in Files.
 */
export function LibraryFiles(props: { bot: RosterBot; onOpen(files: FilesAt): void }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const now = useNow();
  const [filter, setFilter] = useState<LibraryFilesFilter>("all");

  const root = useQuery({
    queryKey: ["spade", "workspace", machine.key, bot.id, ""],
    queryFn: ({ signal }) => readFolder(client, bot.id, "", { signal }),
  });

  const rootEntries = root.data?.entries ?? [];
  const downloadsDir = rootEntries.find(
    (entry) => entry.kind === "folder" && downloadFolders.has(entry.name.toLowerCase()),
  )?.path;
  const fromYouDir = rootEntries.find(
    (entry) => entry.kind === "folder" && fromYouFolders.has(entry.name.toLowerCase()),
  )?.path;

  const targetDir =
    filter === "downloads" ? downloadsDir : filter === "you" ? fromYouDir : undefined;

  const sub = useQuery({
    queryKey: ["spade", "workspace", machine.key, bot.id, targetDir ?? "__none__"],
    queryFn: ({ signal }) => readFolder(client, bot.id, targetDir ?? "", { signal }),
    enabled: Boolean(targetDir),
  });

  const activePending =
    root.isPending ||
    ((filter === "downloads" || filter === "you") && Boolean(targetDir) && sub.isPending);
  const activeError =
    root.isError ||
    ((filter === "downloads" || filter === "you") && Boolean(targetDir) && sub.isError);

  const entries =
    filter === "downloads" || filter === "you"
      ? targetDir
        ? (sub.data?.entries ?? [])
        : []
      : filterLibraryFiles(rootEntries, filter);

  const groups = filesByAge(entries, now);
  const shown = groups
    .map((group, at) => {
      const before = groups.slice(0, at).reduce((sum, each) => sum + each.entries.length, 0);
      return {
        label: group.label,
        entries: group.entries.slice(0, Math.max(0, shownFiles - before)),
      };
    })
    .filter((group) => group.entries.length > 0);

  const emptyMessage =
    filter === "downloads"
      ? "No downloaded files yet."
      : filter === "you"
        ? "No files sent by you yet."
        : filter === "bot"
          ? `${bot.name} hasn't made any files yet.`
          : `${bot.name} hasn't kept any files yet.`;

  return (
    <ProfileSection
      label="Files"
      bare
      actions={
        rootEntries.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className={rowPill}
            onClick={() => props.onOpen({ folder: targetDir ?? "" })}
          >
            All files
          </Button>
        )
      }
    >
      {rootEntries.length > 0 && (
        <div
          role="group"
          aria-label="Filter files"
          className="mb-3 flex flex-wrap items-center gap-1.5"
        >
          {filterOptions.map((option) => {
            const active = filter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(option.id)}
                className={cn(
                  "h-7 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring",
                  active
                    ? "bg-surface-1 text-foreground shadow-[inset_0_0_0_1px_var(--border-soft)]"
                    : "text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
      {activePending ? (
        <ProfileCardSkeleton card label="files" leading="thumb" rows={2} />
      ) : activeError ? (
        <ProfileProblem
          card
          text="Couldn't read the files."
          onRetry={() => {
            void root.refetch();
            if (targetDir) void sub.refetch();
          }}
        />
      ) : entries.length === 0 ? (
        <ProfileNone
          action={
            filter === "all" ? (
              <Button
                size="sm"
                variant="ghost"
                className={rowPill}
                onClick={() => props.onOpen({ folder: "" })}
              >
                Open files
              </Button>
            ) : undefined
          }
        >
          {emptyMessage}
        </ProfileNone>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((group) => (
            <div key={group.label} className="flex flex-col">
              <h4 className="mx-1 mb-1.5 text-xs font-medium text-subtle-foreground">
                {group.label}
              </h4>
              <ProfileCard>
                {group.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    data-setting-slot=""
                    {...part("list-row", undefined, entry.kind)}
                    onClick={() =>
                      props.onOpen(
                        entry.kind === "folder"
                          ? { folder: entry.path }
                          : { folder: folderOf(entry.path), file: entry.path },
                      )
                    }
                    className={cn(profileRowClass, "min-h-11 py-2.5")}
                  >
                    <FileThumb bot={bot.id} entry={entry} variant="tile" />
                    <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
                      {entry.name}
                    </span>
                    {entry.modifiedAt !== undefined && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatAge(entry.modifiedAt, now)}
                      </span>
                    )}
                    <Icon
                      icon={CaretRightIcon}
                      size={16}
                      className="shrink-0 text-faint-foreground"
                    />
                  </button>
                ))}
              </ProfileCard>
            </div>
          ))}
        </div>
      )}
    </ProfileSection>
  );
}
