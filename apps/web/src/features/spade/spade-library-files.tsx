import { formatAge } from "@ace/ui-core/time";
import { FileIcon, FolderIcon } from "@ace/icons";
import type { SpadeFileEntry } from "@ace/ui-core/spade-chat";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/lib/time.ts";
import { part } from "@/lib/suit-part.ts";
import type { FilesAt } from "./computer/profile-computer.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileNone, ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { SettingCard } from "@/components/setting-row.tsx";
import { downloadFile, readFolder } from "./spade-workspace-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** Files shown before All files. */
const shownFiles = 12;
const week = 7 * 24 * 60 * 60 * 1000;
const pictures = /\.(png|jpe?g|gif|webp)$/i;
/** A picture is drawn as its own thumbnail up to this size. */
const thumbBytes = 2_000_000;

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

/** A small tile: the picture itself for an image, else its kind's glyph. */
function Thumb(props: { bot: string; entry: SpadeFileEntry }) {
  const client = useSpadeClient();
  const { bot, entry } = props;
  const [url, setUrl] = useState<string>();
  const picture = entry.kind === "file" && pictures.test(entry.name) && entry.size <= thumbBytes;
  useEffect(() => {
    if (!picture) return;
    let live = true;
    let made: string | undefined;
    downloadFile(client, bot, entry.path).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => {},
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, bot, entry.path, picture]);
  return url ? (
    <img alt="" src={url} className="size-6 shrink-0 rounded-sm object-cover" />
  ) : (
    <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-hover text-muted-foreground">
      <Icon icon={entry.kind === "folder" ? FolderIcon : FileIcon} size={14} />
    </span>
  );
}

/**
 * The top of its workspace, newest kept first, grouped Recent and Older, each a row with a small
 * thumbnail; a file or folder opens in Computer's Files.
 */
export function LibraryFiles(props: { bot: RosterBot; onOpen(files: FilesAt): void }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const now = useNow();
  const listing = useQuery({
    queryKey: ["spade", "workspace", machine.key, bot.id, ""],
    queryFn: ({ signal }) => readFolder(client, bot.id, "", { signal }),
  });
  const entries = listing.data?.entries ?? [];
  const groups = filesByAge(entries, now);
  let left = shownFiles;
  const shown = groups.map((group) => {
    const take = group.entries.slice(0, Math.max(0, left));
    left -= take.length;
    return { label: group.label, entries: take };
  });
  return (
    <ProfileSection
      label="Files"
      bare
      actions={
        entries.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className={rowPill}
            onClick={() => props.onOpen({ folder: "" })}
          >
            All files
          </Button>
        )
      }
    >
      {listing.isPending ? (
        <ListSkeleton label="files" shape="row" rows={2} />
      ) : listing.isError ? (
        <ProfileProblem text="Couldn't read the files." onRetry={() => void listing.refetch()} />
      ) : entries.length === 0 ? (
        <ProfileNone>{`${bot.name} hasn't kept any files yet.`}</ProfileNone>
      ) : (
        shown
          .filter((group) => group.entries.length > 0)
          .map((group) => (
            <div key={group.label} className="mb-4 flex flex-col">
              <h4 className="mx-1 mb-1.5 text-ui text-muted-foreground">{group.label}</h4>
              <SettingCard>
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
                          : { folder: "", file: entry.path },
                      )
                    }
                    className="group/file flex min-h-11 min-w-0 items-center gap-3 rounded-sm py-2 text-left text-ui text-foreground focus-ring"
                  >
                    <Thumb bot={bot.id} entry={entry} />
                    <span className="min-w-0 flex-1 truncate group-hover/file:underline">
                      {entry.name}
                    </span>
                    {entry.modifiedAt !== undefined && (
                      <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                        {formatAge(entry.modifiedAt, now)}
                      </span>
                    )}
                  </button>
                ))}
              </SettingCard>
            </div>
          ))
      )}
    </ProfileSection>
  );
}
