import { formatBytes } from "@ace/ui-core/byte-size";
import { formatAgo } from "@ace/ui-core/time";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import {
  deletePath,
  downloadFile,
  readFile,
  readFolder,
  type SpadeFileEntry,
} from "./spade-workspace-api.ts";

const row =
  "group flex h-(--row-height) w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-md hover:bg-hover focus-within:bg-hover";

/**
 * A bot's files (ADR 0130): its workspace folder, one level at a time. The path reads as words
 * that lead back up; a row opens its folder or file; Download and Delete come with the row under
 * the pointer or focus. A text file opens read-only below its path.
 */
export function SpadeFiles(props: {
  bot: { id: string; name: string };
  /** The folder shown, relative to the workspace; empty for its top. */
  folder: string;
  onFolder(path: string): void;
}) {
  const { bot, folder } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const cache = useQueryClient();
  const toast = useToast();
  const [opened, setOpened] = useState<string>();
  const [confirming, setConfirming] = useState<Confirming>();
  const folderKey = ["spade", "workspace", machine.key, bot.id, folder] as const;
  const listing = useQuery({
    queryKey: folderKey,
    queryFn: ({ signal }) => readFolder(client, bot.id, folder, { signal }),
  });
  const open = (path: string) => setOpened(path);
  const download = (path: string) =>
    void downloadFile(client, bot.id, path).then(
      (blob) => saveAs(blob, path.split("/").at(-1) ?? "file"),
      (error: unknown) =>
        toast.error({ title: "Couldn't download the file", description: message(error) }),
    );
  const remove = (entry: Pick<SpadeFileEntry, "path" | "name" | "kind">) =>
    setConfirming({
      title: `Delete ${entry.name}?`,
      body:
        entry.kind === "folder"
          ? `This deletes ${entry.path} and everything in it from ${bot.name}'s files.`
          : `This deletes ${entry.path} from ${bot.name}'s files.`,
      confirm: "Delete",
      run: () =>
        void deletePath(client, bot.id, entry.path).then(
          () => {
            if (opened === entry.path) setOpened(undefined);
            void cache.invalidateQueries({ queryKey: ["spade", "workspace", machine.key, bot.id] });
          },
          (error: unknown) =>
            toast.error({ title: `Couldn't delete ${entry.name}`, description: message(error) }),
        ),
    });

  return (
    <div className={`${readingColumn} flex flex-col gap-4 pt-6 pb-8`}>
      {/* At the top the bar's "Files" already says where this is. */}
      {(folder || opened) && (
        <Trail
          folder={folder}
          file={opened}
          onFolder={(path) => {
            setOpened(undefined);
            props.onFolder(path);
          }}
        />
      )}
      {opened ? (
        <OpenFile
          bot={bot.id}
          path={opened}
          onDownload={() => download(opened)}
          onDelete={() =>
            remove({ path: opened, name: opened.split("/").at(-1) ?? opened, kind: "file" })
          }
        />
      ) : listing.isPending ? (
        <LoadingRegion label="Files" className="flex flex-col gap-1">
          <Skeleton className="h-(--row-height) w-full rounded-md" />
          <Skeleton className="h-(--row-height) w-2/3 rounded-md" />
        </LoadingRegion>
      ) : listing.isError ? (
        <div role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
          <span className="min-w-0 flex-1">{message(listing.error)}</span>
          <Button size="xs" variant="ghost" onClick={() => void listing.refetch()}>
            Try again
          </Button>
        </div>
      ) : listing.data.entries.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          {folder ? "This folder is empty." : `${bot.name} hasn't kept any files yet.`}
        </p>
      ) : (
        <ul aria-label="Files" className="-mx-2.5 flex flex-col gap-0.5">
          {listing.data.entries.map((entry) => (
            <li key={entry.path} className={row}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-ring-inset rounded-sm"
                onClick={() =>
                  entry.kind === "folder" ? props.onFolder(entry.path) : open(entry.path)
                }
              >
                <span className="min-w-0 flex-1 truncate">
                  {entry.name}
                  {entry.kind === "folder" ? "/" : ""}
                </span>
                <span className="shrink-0 text-meta text-muted-foreground tabular-nums group-hover:hidden group-focus-within:hidden">
                  {facts(entry)}
                </span>
              </button>
              <span className="hidden shrink-0 gap-1 group-hover:flex group-focus-within:flex">
                {entry.kind === "file" && (
                  <Button size="xs" variant="ghost" onClick={() => download(entry.path)}>
                    Download
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => remove(entry)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
          {listing.data.truncated && (
            <li className="px-2.5 pt-1 text-ui text-muted-foreground">
              Only the first {listing.data.entries.length} are shown.
            </li>
          )}
        </ul>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}

/** A row's own facts: a file's size and age, a link as such. */
function facts(entry: SpadeFileEntry): string {
  if (entry.kind === "link") return "Link";
  const age = entry.modifiedAt === undefined ? undefined : formatAgo(entry.modifiedAt, Date.now());
  if (entry.kind === "folder") return age ?? "";
  return age ? `${formatBytes(entry.size)} · ${age}` : formatBytes(entry.size);
}

/** "Files / reports / week.md": each folder leads back to itself; the last part is where you are. */
function Trail(props: { folder: string; file: string | undefined; onFolder(path: string): void }) {
  const parts = props.folder ? props.folder.split("/") : [];
  const fileName = props.file?.split("/").at(-1);
  const crumbs = [
    { label: "Files", path: "" },
    ...parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join("/") })),
  ];
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-ui">
      {crumbs.map((crumb, index) => {
        const here = !fileName && index === crumbs.length - 1;
        return (
          <span key={crumb.path} className="flex min-w-0 items-center gap-1">
            {index > 0 && <span className="text-subtle-foreground">/</span>}
            {here ? (
              <span aria-current="page" className="truncate font-medium text-foreground">
                {crumb.label}
              </span>
            ) : (
              <button
                type="button"
                className="truncate rounded-sm text-muted-foreground hover:text-foreground focus-ring"
                onClick={() => props.onFolder(crumb.path)}
              >
                {crumb.label}
              </button>
            )}
          </span>
        );
      })}
      {fileName && (
        <>
          <span className="text-subtle-foreground">/</span>
          <span aria-current="page" className="truncate font-medium text-foreground">
            {fileName}
          </span>
        </>
      )}
    </nav>
  );
}

function OpenFile(props: { bot: string; path: string; onDownload(): void; onDelete(): void }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const file = useQuery({
    queryKey: ["spade", "workspace", machine.key, props.bot, "file", props.path],
    queryFn: ({ signal }) => readFile(client, props.bot, props.path, { signal }),
  });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="-ml-2 flex items-center gap-1">
        <Button size="xs" variant="ghost" onClick={props.onDownload}>
          Download
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onDelete}>
          Delete
        </Button>
        {file.data && (
          <span className="ml-auto text-meta text-muted-foreground tabular-nums">
            {formatBytes(file.data.size)}
          </span>
        )}
      </div>
      {file.isPending ? (
        <LoadingRegion label="File">
          <Skeleton className="h-40 w-full rounded-md" />
        </LoadingRegion>
      ) : file.isError ? (
        <p role="alert" className="text-ui text-muted-foreground">
          {message(file.error)}
        </p>
      ) : file.data.text === undefined ? (
        <p className="text-ui text-muted-foreground">
          {file.data.unreadable === "too_large"
            ? "Too large to show here. Download it to open it."
            : "This file isn't text. Download it to open it."}
        </p>
      ) : (
        <pre
          aria-label={props.path}
          className={cn(
            "overflow-auto rounded-md bg-code px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap wrap-anywhere shadow-[inset_0_0_0_1px_var(--border)]",
          )}
        >
          {file.data.text || " "}
        </pre>
      )}
    </div>
  );
}

/** Hands `blob` to the browser as a download named `name`. */
function saveAs(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Try again.");
