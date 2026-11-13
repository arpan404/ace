import { formatBytes } from "@ace/ui-core/byte-size";
import { formatAgo } from "@ace/ui-core/time";
import { DotsThreeIcon, FileIcon, FolderIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { ConversationFollow } from "../conversation-follow.ts";
import { saveAs } from "../save-as.ts";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import {
  deletePath,
  downloadFile,
  readFolder,
  type SpadeFileEntry,
} from "../spade-workspace-api.ts";
import { makeFolder, movePath, uploadFile } from "./computer-api.ts";
import { FileEditor } from "./file-editor.tsx";

/**
 * A bot's files as a file manager: one folder at a time under a trail that leads back up, Upload
 * and New folder beside it. A row opens its folder or file; its ⋯ downloads, renames or moves
 * (typing a path with folders moves it), or deletes after asking. A text file opens to edit and
 * save. The list reads again when the bot's stream says its files changed.
 */
export function FileManager(props: {
  bot: { id: string; name: string };
  folder: string;
  file: string | undefined;
  /** Shows another folder, or a file in it. */
  onOpen(to: { folder: string; file?: string | undefined }): void;
  side: Pick<ConversationFollow, "onSide"> | undefined;
}) {
  const { bot, folder } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const cache = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Confirming>();
  const [renaming, setRenaming] = useState<string>();
  const [making, setMaking] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const workspaceKey = ["spade", "workspace", machine.key, bot.id] as const;
  const listing = useQuery({
    queryKey: [...workspaceKey, folder],
    queryFn: ({ signal }) => readFolder(client, bot.id, folder, { signal }),
  });
  const refresh = () => void cache.invalidateQueries({ queryKey: workspaceKey });
  useEffect(
    () =>
      props.side?.onSide("files", () => void cache.invalidateQueries({ queryKey: workspaceKey })),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the key is the bot's, fixed per mount
    [props.side, cache],
  );
  const failed = (title: string) => (error: unknown) =>
    toast.error({ title, description: message(error) });
  const inFolder = (name: string) => (folder ? `${folder}/${name}` : name);

  const upload = async (files: FileList) => {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await uploadFile(client, bot.id, inFolder(file.name), bytes).catch(
        failed(`Couldn't upload ${file.name}`),
      );
    }
    refresh();
  };
  const download = (path: string) =>
    void downloadFile(client, bot.id, path).then(
      (blob) => saveAs(blob, path.split("/").at(-1) ?? "file"),
      failed("Couldn't download the file"),
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
            if (props.file === entry.path) props.onOpen({ folder });
            refresh();
          },
          failed(`Couldn't delete ${entry.name}`),
        ),
    });
  const move = (from: string, to: string) => {
    setRenaming(undefined);
    const target = to.trim().replace(/^\/+|\/+$/g, "");
    if (!target || target === from) return;
    void movePath(client, bot.id, from, target).then(refresh, failed(`Couldn't move ${from}`));
  };
  const create = (name: string) => {
    setMaking(false);
    const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return;
    void makeFolder(client, bot.id, inFolder(trimmed)).then(
      refresh,
      failed(`Couldn't make ${trimmed}`),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Trail
          folder={folder}
          file={props.file}
          onFolder={(path) => props.onOpen({ folder: path })}
        />
        {!props.file && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => picker.current?.click()}>
              Upload
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setMaking(true)}>
              New folder
            </Button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Files to upload"
              onChange={(event) => {
                const files = event.target.files;
                if (files?.length) void upload(files);
                event.target.value = "";
              }}
            />
          </span>
        )}
      </div>
      {props.file ? (
        <FileEditor
          key={props.file}
          bot={bot.id}
          path={props.file}
          onDownload={() => download(props.file ?? "")}
          onDelete={() =>
            remove({
              path: props.file ?? "",
              name: props.file?.split("/").at(-1) ?? "",
              kind: "file",
            })
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {making && <NameField label="New folder name" initial="" onDone={create} />}
          {listing.isPending ? (
            <LoadingRegion label="Files" className="flex flex-col gap-1 px-2">
              <Skeleton className="h-(--row-height) w-full rounded-md" />
              <Skeleton className="h-(--row-height) w-2/3 rounded-md" />
            </LoadingRegion>
          ) : listing.isError ? (
            <div
              role="alert"
              className="flex items-center gap-2 px-2 text-ui text-muted-foreground"
            >
              <span className="min-w-0 flex-1">{message(listing.error)}</span>
              <Button size="xs" variant="ghost" onClick={() => void listing.refetch()}>
                Try again
              </Button>
            </div>
          ) : listing.data.entries.length === 0 && !making ? (
            <p className="px-2 pt-2 text-ui text-muted-foreground">
              {folder ? "This folder is empty." : `${bot.name} hasn't kept any files yet.`}
            </p>
          ) : (
            <ul aria-label="Files" className="flex flex-col gap-0.5">
              {listing.data.entries.map((entry) =>
                renaming === entry.path ? (
                  <li key={entry.path}>
                    <NameField
                      label={`New name or path for ${entry.name}`}
                      initial={entry.path}
                      onDone={(to) => move(entry.path, to)}
                    />
                  </li>
                ) : (
                  <li
                    key={entry.path}
                    className="group flex h-(--row-height) min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-hover focus-within:bg-hover"
                  >
                    <button
                      type="button"
                      className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left text-md focus-ring-inset"
                      onClick={() =>
                        entry.kind === "folder"
                          ? props.onOpen({ folder: entry.path })
                          : props.onOpen({ folder, file: entry.path })
                      }
                    >
                      <Icon
                        icon={entry.kind === "folder" ? FolderIcon : FileIcon}
                        size={16}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                        {facts(entry)}
                      </span>
                    </button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <IconButton
                            icon={DotsThreeIcon}
                            size="sm"
                            label={`More for ${entry.name}`}
                            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
                          />
                        }
                      />
                      <MenuContent align="end">
                        {entry.kind === "file" && (
                          <MenuItem onClick={() => download(entry.path)}>Download</MenuItem>
                        )}
                        <MenuItem onClick={() => setRenaming(entry.path)}>Rename or move</MenuItem>
                        <MenuItem danger onClick={() => remove(entry)}>
                          Delete
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </li>
                ),
              )}
              {listing.data.truncated && (
                <li className="px-2.5 pt-1 text-ui text-muted-foreground">
                  Only the first {listing.data.entries.length} are shown.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}

/** A name typed in place: Enter keeps it, Esc or leaving the field drops it. */
function NameField(props: { label: string; initial: string; onDone(value: string): void }) {
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
      className="mb-0.5 h-(--row-height) w-full rounded-md bg-secondary px-2.5 text-md text-foreground focus-ring"
    />
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
    <nav aria-label="Folder" className="flex min-w-0 items-center gap-1 overflow-hidden text-ui">
      {crumbs.map((crumb, index) => {
        const here = !fileName && index === crumbs.length - 1;
        return (
          <span key={crumb.path} className="flex min-w-0 items-center gap-1">
            {index > 0 && <span className="text-subtle-foreground">/</span>}
            {here ? (
              <span aria-current="page" className="truncate text-foreground">
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
          <span aria-current="page" className="truncate text-foreground">
            {fileName}
          </span>
        </>
      )}
    </nav>
  );
}
