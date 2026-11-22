import {
  focusedGroup,
  groupsOf,
  openEditor,
  openEditorToSide,
  type EditorLayout,
} from "@ace/ui-core/editor-workbench";
import { FolderPlusIcon, SidebarSimpleIcon, UploadSimpleIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useElementSize } from "@/lib/element-size.ts";
import { groupIds } from "@/lib/workspace/index.ts";
import type { ConversationFollow } from "../conversation-follow.ts";
import { saveAs } from "../save-as.ts";
import { SpadeRequestError } from "../spade-requests.ts";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import {
  deletePath,
  downloadFile,
  readFile,
  type SpadeFileEntry,
  type SpadeFolder,
} from "../spade-workspace-api.ts";
import { changedSinceOpened, makeFolder, movePath, uploadFile } from "./computer-api.ts";
import { SpadeEditor, useSpadeEditorLayout } from "./editor/spade-editor.tsx";
import {
  bindSpadeRoot,
  spadeEditorRegistry,
  spadeEditorRoot,
} from "./editor/spade-editor-registry.ts";
import { SpadeFileTree, type OpenHow } from "./editor/spade-file-tree.tsx";

/** Why a change to the bot's files can't be made now: the computer is changing hands. */
export const notNowToChange = "Files can change once the computer is yours or shared again";

/** Narrower than this, the files and the editor take turns instead of sitting side by side. */
const sideBySide = 560;

/**
 * A bot's files in ace's editor: its explorer (the files as a tree, Upload, New folder, and on
 * each row's ⋯ Download, Rename or move, Delete after asking) beside the editor's tabs. The tree
 * reads again, and open files check their revision, when the bot's stream says its files changed.
 * Browsing and downloads always work; every change needs the person able to act (`writable`:
 * cowork, or exclusive while they drive), checked again right before it goes, so nothing lands
 * while the computer changes hands.
 */
/** What the person saw of a file before changing it. */
type Seen =
  | { kind: "revision"; revision: string | undefined }
  | { kind: "gone" }
  | { kind: "unchecked" };
/** A folder, or a name with no file: nothing to name a revision of. */
const unseen: Seen = { kind: "revision", revision: undefined };
const couldntCheck = "Couldn't check the file. Try again.";

/** Every folder on the way to `folder`, outermost first: "a", "a/b". */
const foldersTo = (folder: string) =>
  folder ? folder.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")) : [];

export function FileManager(props: {
  bot: { id: string; name: string };
  /** The folder a link pointed at: it opens in the tree, and new files go there. */
  folder: string;
  /** A file a link asked to open: it opens in the editor, kept. */
  file: string | undefined;
  side: Pick<ConversationFollow, "onSide" | "onEnded"> | undefined;
  /** The person may act: their changes may go to Spade. */
  writable: boolean;
}) {
  const { bot } = props;
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
  /** The folder a new folder's name is being typed in. */
  const [making, setMaking] = useState<string>();
  /** Where Upload and New folder put things: the folder last opened in the tree. */
  const [folder, setFolder] = useState(props.folder);
  const picker = useRef<HTMLInputElement>(null);
  const workspaceKey = ["spade", "workspace", machine.key, bot.id] as const;
  const folderKey = (path: string) => [...workspaceKey, path] as const;
  const root = spadeEditorRoot(machine.key, bot.id);
  const registry = spadeEditorRegistry(client);
  const { layout, change, current } = useSpadeEditorLayout(root);
  // The editor's buffers read once its passive effects run: the bot's files are bound in a layout
  // effect, which runs before them. A binding stays (see `bindSpadeRoot`), so it needs no cleanup.
  useLayoutEffect(() => {
    bindSpadeRoot(root, {
      target: client,
      bot: bot.id,
      name: bot.name,
      mayWrite: () => (writable.current ? true : new Error(notNowToChange)),
    });
  }, [root, client, bot.id, bot.name]);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: workspaceKey });
    registry.recheck(root);
  };
  useEffect(
    () =>
      props.side?.onSide("files", () => {
        void cache.invalidateQueries({ queryKey: workspaceKey });
        registry.recheck(root);
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the key is the bot's, fixed per mount
    [props.side, cache, registry, root],
  );

  // Room: side by side when there is, else the files and the editor take turns.
  const box = useRef<HTMLDivElement>(null);
  const width = useElementSize(box).width;
  const narrow = width < sideBySide;
  const [browsing, setBrowsing] = useState(false);
  const explorer = layout.explorer;
  const showFiles = narrow ? browsing || !anyOpen(layout) : explorer.open;
  const setExplorer = (patch: Partial<EditorLayout["explorer"]>) =>
    change({ ...current(), explorer: { ...current().explorer, ...patch } });
  const expanded = new Set(explorer.expanded);
  const toggle = (path: string) => {
    const now = new Set(current().explorer.expanded);
    if (now.has(path)) now.delete(path);
    else {
      now.add(path);
      setFolder(path);
    }
    setExplorer({ expanded: [...now] });
  };
  const open = (path: string, how: OpenHow) => {
    const now = current();
    change(
      how === "side"
        ? openEditorToSide(now, path, { intent: "keep" }, groupIds(now))
        : openEditor(now, path, { intent: how === "keep" ? "keep" : "glance" }),
    );
    setBrowsing(false);
  };
  // A link's folder opens in the tree (new files go there), and its file in the editor.
  const [linked, setLinked] = useState({ folder: props.folder, file: props.file });
  if (linked.folder !== props.folder || linked.file !== props.file) {
    setLinked({ folder: props.folder, file: props.file });
    if (linked.folder !== props.folder) setFolder(props.folder);
    if (linked.file !== props.file) setBrowsing(false);
  }
  useEffect(() => {
    if (!props.folder) return;
    const now = current();
    const wanted = foldersTo(props.folder).filter((path) => !now.explorer.expanded.includes(path));
    if (wanted.length)
      change({
        ...now,
        explorer: { ...now.explorer, expanded: [...now.explorer.expanded, ...wanted] },
      });
  }, [props.folder, change, current]);
  useEffect(() => {
    if (props.file !== undefined) change(openEditor(current(), props.file, { intent: "keep" }));
  }, [props.file, change, current]);

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
      const replaced = cache
        .getQueryData<SpadeFolder>(folderKey(folder))
        ?.entries.some((entry) => entry.kind === "file" && entry.path === path);
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
            refresh,
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
    setMaking(undefined);
    if (!name || !mayWrite()) return;
    void makeFolder(client, bot.id, inFolder(name)).then(refresh, failed(`Couldn't make ${name}`));
  };
  const reason = props.writable ? undefined : notNowToChange;
  const menu = (entry: SpadeFileEntry) => (
    <>
      {entry.kind !== "folder" && (
        <MenuItem onClick={() => open(entry.path, "keep")}>Open</MenuItem>
      )}
      {entry.kind !== "folder" && (
        <MenuItem onClick={() => open(entry.path, "side")}>Open to the side</MenuItem>
      )}
      {entry.kind === "file" && <MenuItem onClick={() => download(entry.path)}>Download</MenuItem>}
      <MenuItem disabled={!props.writable} reason={reason} onClick={() => startRename(entry)}>
        Rename or move
      </MenuItem>
      <MenuItem danger disabled={!props.writable} reason={reason} onClick={() => remove(entry)}>
        Delete
      </MenuItem>
    </>
  );
  const currentFile = focusedGroup(layout).active;

  return (
    <div
      ref={box}
      className="flex h-[max(26rem,calc(100dvh-24rem))] min-h-0 overflow-hidden border-y border-border"
    >
      {showFiles && (
        <aside
          aria-label={`${bot.name}'s files`}
          style={narrow ? undefined : { width: Math.min(explorer.width, 240) }}
          className={
            narrow
              ? "flex min-w-0 flex-1 flex-col"
              : "flex shrink-0 flex-col border-r border-border"
          }
        >
          <div
            data-part="tabs"
            className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pr-1.5 pl-3"
          >
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-muted-foreground">
              Files
            </span>
            <DisabledReason reason={reason}>
              <IconButton
                icon={UploadSimpleIcon}
                label="Upload"
                disabled={!props.writable}
                onClick={() => picker.current?.click()}
                className="size-7 rounded-sm hover:bg-hover"
              />
            </DisabledReason>
            <DisabledReason reason={reason}>
              <IconButton
                icon={FolderPlusIcon}
                label="New folder"
                disabled={!props.writable}
                onClick={() => setMaking(folder)}
                className="size-7 rounded-sm hover:bg-hover"
              />
            </DisabledReason>
            {(narrow ? anyOpen(layout) : true) && (
              <IconButton
                icon={SidebarSimpleIcon}
                label={narrow ? "Back to the editor" : "Hide files"}
                onClick={() => (narrow ? setBrowsing(false) : setExplorer({ open: false }))}
                className="size-7 rounded-sm hover:bg-hover"
              />
            )}
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
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SpadeFileTree
              tree={{
                bot,
                folderKey,
                expanded,
                toggle,
                current: currentFile,
                open,
                renaming,
                onRenamed: move,
                making,
                onMade: create,
                menu,
              }}
            />
          </div>
        </aside>
      )}
      {!(narrow && showFiles) && (
        <SpadeEditor
          root={root}
          bot={bot}
          layout={layout}
          onLayoutChange={change}
          current={current}
          writable={props.writable}
          onDownload={download}
          explorerToggle={
            showFiles ? undefined : (
              <IconButton
                icon={SidebarSimpleIcon}
                label="Show files"
                onClick={() => (narrow ? setBrowsing(true) : setExplorer({ open: true }))}
                className="ml-1 size-7 shrink-0 rounded-sm hover:bg-hover"
              />
            )
          }
        />
      )}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );
}

/** Whether any pane has a file open. */
const anyOpen = (layout: EditorLayout) => groupsOf(layout).some((group) => group.tabs.length > 0);
