import { formatBytes } from "@ace/ui-core/byte-size";
import { formatAgo } from "@ace/ui-core/time";
import { DotsThreeIcon, FileIcon, FolderIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { ConversationFollow } from "../conversation-follow.ts";
import { saveAs } from "../save-as.ts";
import { SpadeRequestError } from "../spade-requests.ts";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import {
  deletePath,
  downloadFile,
  readFile,
  readFolder,
  type SpadeFileEntry,
} from "../spade-workspace-api.ts";
import { changedSinceOpened, makeFolder, movePath, uploadFile } from "./computer-api.ts";
import { FileEditor, notNowToChange } from "./file-editor.tsx";

/**
 * A bot's files as a file manager: one folder at a time under a trail that leads back up, Upload
 * and New folder beside it. A row opens its folder or file; its ⋯ downloads, renames or moves
 * (typing a path with folders moves it), or deletes after asking. A text file opens to edit and
 * save. The list reads again when the bot's stream says its files changed. Browsing and downloads
 * always work; every change needs the person able to act (`writable`: cowork, or exclusive while
 * they drive), checked again right before it goes, so nothing lands while the computer changes
 * hands.
 */
/** What the person saw of a file before changing it. */
type Seen =
  | { kind: "revision"; revision: string | undefined }
  | { kind: "gone" }
  | { kind: "unchecked" };
/** A folder, or a name with no file: nothing to name a revision of. */
const unseen: Seen = { kind: "revision", revision: undefined };
const couldntCheck = "Couldn't check the file. Try again.";

export function FileManager(props: {
  bot: { id: string; name: string };
  folder: string;
  file: string | undefined;
  /** Shows another folder, or a file in it. */
  onOpen(to: { folder: string; file?: string | undefined }): void;
  side: Pick<ConversationFollow, "onSide" | "onEnded"> | undefined;
  /** The person may act: their changes may go to Spade. */
  writable: boolean;
}) {
  const { bot, folder } = props;
  // Read again right before each change goes, after any wait (a confirmation, a file's bytes).
  const writable = useRef(props.writable);
  useEffect(() => {
    writable.current = props.writable;
  }, [props.writable]);
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
    toast.error({
      title,
      description: changedSinceOpened(error)
        ? "It changed since you opened it. Look again, then try once more."
        : message(error),
    });
  /**
   * A file as the person sees it now, read when they begin a change (opening Delete's question,
   * starting a rename, picking a file to replace): the change names its revision and is refused
   * if the file moves on before it goes. Fails closed: when the read fails, nothing is sent.
   */
  const seenOf = (path: string): Promise<Seen> =>
    readFile(client, bot.id, path).then(
      (file): Seen => ({ kind: "revision", revision: file.revision }),
      (error: unknown): Seen =>
        error instanceof SpadeRequestError && error.status === 404
          ? { kind: "gone" }
          : { kind: "unchecked" },
    );
  /** What the person saw of the file a rename started from. */
  const renameSeen = useRef<Promise<Seen>>(undefined);
  const inFolder = (name: string) => (folder ? `${folder}/${name}` : name);
  /** Whether a change may go now; says why not when it can't. */
  const mayWrite = () => {
    if (writable.current) return true;
    toast.error({ title: notNowToChange });
    return false;
  };
  /**
   * The revision a change of `name` goes with, or undefined after saying why it can't go: the
   * file couldn't be checked, or (for a change of the file itself) it is gone.
   */
  const baseFor = (saw: Seen, name: string): { revision: string | undefined } | undefined => {
    if (saw.kind === "revision") return { revision: saw.revision };
    if (saw.kind === "unchecked") toast.error({ title: couldntCheck });
    else {
      toast.error({ title: `${name} is gone`, description: "It was deleted or moved meanwhile." });
      refresh();
    }
    return undefined;
  };

  const upload = async (files: FileList) => {
    for (const file of files) {
      if (!mayWrite()) break;
      const path = inFolder(file.name);
      // Replacing a file shown here: only the one the person saw.
      const replaced = listing.data?.entries.some(
        (entry) => entry.kind === "file" && entry.path === path,
      );
      const seen = replaced ? seenOf(path) : Promise.resolve(unseen);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saw = await seen;
      // Gone since: a new file, which needs no revision. Unreadable: not this one.
      if (saw.kind === "unchecked") {
        toast.error({ title: couldntCheck, description: file.name });
        continue;
      }
      // Reading took a while: the person may have handed back meanwhile.
      if (!mayWrite()) break;
      const opened = saw.kind === "revision" ? saw.revision : undefined;
      await uploadFile(client, bot.id, path, bytes, opened).catch(
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
  /** Asks first; `opened` is the revision the person saw (the open file's), else read now. */
  const remove = (entry: Pick<SpadeFileEntry, "path" | "name" | "kind">, opened?: string) => {
    const seen: Promise<Seen> =
      entry.kind === "file" && opened === undefined
        ? seenOf(entry.path)
        : Promise.resolve({ kind: "revision", revision: opened });
    setConfirming({
      title: `Delete ${entry.name}?`,
      body:
        entry.kind === "folder"
          ? `This deletes ${entry.path} and everything in it from ${bot.name}'s files.`
          : `This deletes ${entry.path} from ${bot.name}'s files.`,
      confirm: "Delete",
      run: () => {
        // Asked first: the person may have handed back while the question was open.
        if (!mayWrite()) return;
        void seen.then((saw) => {
          const base = baseFor(saw, entry.name);
          // Checked again once the revision is in, right before it goes.
          if (!base || !mayWrite()) return;
          return deletePath(client, bot.id, entry.path, base.revision).then(
            () => {
              if (props.file === entry.path) props.onOpen({ folder });
              refresh();
            },
            failed(`Couldn't delete ${entry.name}`),
          );
        });
      },
    });
  };
  // Paths go as typed: Spade keeps them inside the workspace.
  const startRename = (entry: Pick<SpadeFileEntry, "path" | "kind">) => {
    renameSeen.current = entry.kind === "file" ? seenOf(entry.path) : Promise.resolve(unseen);
    setRenaming(entry.path);
  };
  const move = (from: string, to: string) => {
    setRenaming(undefined);
    const seen = renameSeen.current ?? Promise.resolve(unseen);
    renameSeen.current = undefined;
    if (!to || to === from || !mayWrite()) return;
    void seen.then((saw) => {
      const base = baseFor(saw, from);
      // Checked again once the revision is in, right before it goes.
      if (!base || !mayWrite()) return;
      return movePath(client, bot.id, from, to, base.revision).then(
        refresh,
        failed(`Couldn't move ${from}`),
      );
    });
  };
  const create = (name: string) => {
    setMaking(false);
    if (!name || !mayWrite()) return;
    void makeFolder(client, bot.id, inFolder(name)).then(refresh, failed(`Couldn't make ${name}`));
  };
  const reason = props.writable ? undefined : notNowToChange;

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
            <DisabledReason reason={reason}>
              <Button
                size="xs"
                variant="ghost"
                disabled={!props.writable}
                onClick={() => picker.current?.click()}
              >
                Upload
              </Button>
            </DisabledReason>
            <DisabledReason reason={reason}>
              <Button
                size="xs"
                variant="ghost"
                disabled={!props.writable}
                onClick={() => setMaking(true)}
              >
                New folder
              </Button>
            </DisabledReason>
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
          writable={props.writable}
          mayWrite={mayWrite}
          onDownload={() => download(props.file ?? "")}
          onDelete={(opened) =>
            remove(
              {
                path: props.file ?? "",
                name: props.file?.split("/").at(-1) ?? "",
                kind: "file",
              },
              opened,
            )
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
                        <MenuItem
                          disabled={!props.writable}
                          reason={reason}
                          onClick={() => startRename(entry)}
                        >
                          Rename or move
                        </MenuItem>
                        <MenuItem
                          danger
                          disabled={!props.writable}
                          reason={reason}
                          onClick={() => remove(entry)}
                        >
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
