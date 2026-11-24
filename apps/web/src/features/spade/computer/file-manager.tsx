import { isMarkdownPath } from "@ace/ui-core";
import {
  focusedGroup,
  openEditor,
  openEditorToSide,
  setViewState,
  type EditorLayout,
} from "@ace/ui-core/editor-workbench";
import { DotsThreeIcon, FolderPlusIcon, SidebarSimpleIcon, UploadSimpleIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { groupIds } from "@/lib/workspace/index.ts";
import type { ConversationFollow } from "../conversation-follow.ts";
import { saveAs } from "../save-as.ts";
import { SpadeRequestError } from "../spade-requests.ts";
import { PanelSurfaceHeader, roundButton } from "../spade-profile-parts.tsx";
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
import { PanelFileList } from "./panel-file-list.tsx";
import type { FilesAt } from "./profile-computer.tsx";

/** Why a change to the bot's files can't be made now: the computer is changing hands. */
export const notNowToChange = "Files can change once the computer is yours or shared again";

/** Narrower than this, the panel shows one level at a time instead of tree beside editor. */
const sideBySide = 560;

/** What the side panel gives `FileManager` so its header stays synced with the open file or folder. */
export interface PanelFileHost {
  onBack(): void;
  onExpand(at: FilesAt): void;
}

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
const fileName = (path: string) => path.split("/").at(-1) ?? path;
const parentFolder = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * Whether the panel container is narrower than `breakpoint`, observed on the container itself
 * (never the window). In panel mode without layout measurements (jsdom), stays narrow by default.
 */
function usePanelNarrow(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  breakpoint: number,
): boolean {
  const [narrow, setNarrow] = useState(enabled);
  useLayoutEffect(() => {
    if (!enabled) {
      setNarrow(false);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setNarrow(width < breakpoint);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled, breakpoint]);
  return enabled ? narrow : false;
}

/**
 * A bot's files in ace's editor: full-height desktop tree beside the editor in full screen or a
 * wide panel (>= 560px), and a calm single-level list or clean reader in a narrow side panel
 * (< 560px), adapting to the panel container via `@container/panel`.
 */
export function FileManager(props: {
  bot: { id: string; name: string };
  /** The folder a link pointed at: it opens in the tree, and new files go there. */
  folder: string;
  /** A file a link asked to open: it opens in the editor, kept. */
  file: string | undefined;
  side: Pick<ConversationFollow, "onSide" | "onEnded"> | undefined;
  /** The person may act: their changes may go to Spade. */
  writable: boolean;
  /** Set when mounted inside the side panel: renders the panel header and adapts at 560px. */
  panel?: PanelFileHost | undefined;
}) {
  const { bot, panel } = props;
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
  /** Where Upload and New folder put things: the folder last opened. */
  const [folder, setFolder] = useState(props.folder);
  const [initialFolder, setInitialFolder] = useState(props.folder);
  const [browsing, setBrowsing] = useState(props.file === undefined);
  const [enteredOnFile, setEnteredOnFile] = useState(props.file !== undefined);
  const picker = useRef<HTMLInputElement>(null);
  const workspaceKey = ["spade", "workspace", machine.key, bot.id] as const;
  const folderKey = (path: string) => [...workspaceKey, path] as const;
  const root = spadeEditorRoot(machine.key, bot.id);
  const registry = spadeEditorRegistry(client);
  const { layout, change, current } = useSpadeEditorLayout(root);

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

  // Panel container width: adapts between single-level narrow panel and wide tree+editor.
  const box = useRef<HTMLElement>(null);
  const narrow = usePanelNarrow(box, Boolean(panel), sideBySide);
  const explorer = layout.explorer;
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
    if (linked.folder !== props.folder) {
      setFolder(props.folder);
      setInitialFolder(props.folder);
    }
    if (linked.file !== props.file) {
      setBrowsing(props.file === undefined);
      setEnteredOnFile(props.file !== undefined);
    }
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
  const seenOf = (path: string): Promise<Seen> =>
    readFile(client, bot.id, path).then(
      (file): Seen => ({ kind: "revision", revision: file.revision }),
      (error: unknown): Seen =>
        error instanceof SpadeRequestError && error.status === 404
          ? { kind: "gone" }
          : { kind: "unchecked" },
    );
  const renameSeen = useRef<Promise<Seen>>(undefined);
  const inFolder = (name: string) => (folder ? `${folder}/${name}` : name);
  const mayWrite = () => {
    if (writable.current) return true;
    toast.error({ title: notNowToChange });
    return false;
  };
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
      const replaced = cache
        .getQueryData<SpadeFolder>(folderKey(folder))
        ?.entries.some((entry) => entry.kind === "file" && entry.path === path);
      const seen = replaced ? seenOf(path) : Promise.resolve(unseen);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saw = await seen;
      if (saw.kind === "unchecked") {
        toast.error({ title: couldntCheck, description: file.name });
        continue;
      }
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
      (blob) => saveAs(blob, fileName(path)),
      failed("Couldn't download the file"),
    );
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
        if (!mayWrite()) return;
        void seen.then((saw) => {
          const base = baseFor(saw, entry.name);
          if (!base || !mayWrite()) return;
          return deletePath(client, bot.id, entry.path, base.revision).then(() => {
            if (entry.path === focusedGroup(current()).active) setBrowsing(true);
            refresh();
          }, failed(`Couldn't delete ${entry.name}`));
        });
      },
    });
  };
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
      {entry.kind !== "folder" && !narrow && (
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

  const activeGroup = focusedGroup(layout);
  const currentFile = activeGroup.active;
  const shownFile = browsing ? undefined : (currentFile ?? props.file);
  const showingList = narrow && (browsing || shownFile === undefined);
  const showingFile = narrow && !browsing && shownFile !== undefined;
  const activeTab = shownFile ? activeGroup.tabs.find((tab) => tab.path === shownFile) : undefined;
  const markdownMode =
    shownFile && isMarkdownPath(shownFile)
      ? activeTab?.view?.["markdown"] === "source"
        ? ("source" as const)
        : ("preview" as const)
      : undefined;
  const setMarkdownMode = (next: "preview" | "source") => {
    if (!shownFile) return;
    const now = current();
    const group = focusedGroup(now);
    const tab = group.tabs.find((each) => each.path === shownFile);
    change(
      setViewState(now, { group: group.id, path: shownFile }, { ...tab?.view, markdown: next }),
    );
  };

  const panelTitle = showingFile
    ? fileName(shownFile)
    : narrow && folder
      ? fileName(folder)
      : !narrow && currentFile
        ? fileName(currentFile)
        : "Files";

  const onPanelBack = () => {
    if (!panel) return;
    if (narrow) {
      if (showingFile) {
        if (enteredOnFile) panel.onBack();
        else setBrowsing(true);
        return;
      }
      if (folder && folder !== initialFolder) {
        setFolder(parentFolder(folder));
        return;
      }
    }
    panel.onBack();
  };

  const onPanelExpand = () => {
    if (!panel) return;
    const file = showingList ? undefined : (currentFile ?? (browsing ? undefined : props.file));
    panel.onExpand({
      folder: file ? parentFolder(file) : folder,
      ...(file ? { file } : {}),
    });
  };

  const panelHeaderActions = panel && narrow && (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={DotsThreeIcon}
            label={showingFile ? "File options" : "More"}
            tip="More"
            size="default"
            className={cn(roundButton, "@[560px]/panel:hidden")}
          />
        }
      />
      <MenuContent align="end">
        {showingFile ? (
          <>
            {markdownMode && (
              <>
                <MenuRadioGroup
                  value={markdownMode}
                  onValueChange={(next) =>
                    setMarkdownMode(next === "source" ? "source" : "preview")
                  }
                >
                  <MenuRadioItem value="preview">Preview</MenuRadioItem>
                  <MenuRadioItem value="source">Source</MenuRadioItem>
                </MenuRadioGroup>
                <MenuSeparator />
              </>
            )}
            {enteredOnFile && (
              <MenuItem
                onClick={() => {
                  setEnteredOnFile(false);
                  setBrowsing(true);
                }}
              >
                All files
              </MenuItem>
            )}
            <MenuItem onClick={() => download(shownFile)}>Download</MenuItem>
            <MenuItem
              disabled={!props.writable}
              reason={reason}
              onClick={() => {
                setEnteredOnFile(false);
                setBrowsing(true);
                setFolder(parentFolder(shownFile));
                startRename({ path: shownFile, kind: "file" });
              }}
            >
              Rename or move
            </MenuItem>
            <MenuItem
              danger
              disabled={!props.writable}
              reason={reason}
              onClick={() => remove({ path: shownFile, name: fileName(shownFile), kind: "file" })}
            >
              Delete
            </MenuItem>
          </>
        ) : (
          <>
            <MenuItem
              disabled={!props.writable}
              reason={reason}
              onClick={() => picker.current?.click()}
            >
              Upload
            </MenuItem>
            <MenuItem
              disabled={!props.writable}
              reason={reason}
              onClick={() => setMaking(folder)}
            >
              New folder
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );

  const uploadInput = (
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
  );

  const showDesktopTree = !narrow && explorer.open;
  const body = (
    <div
      className={cn(
        "flex min-h-0 flex-1 overflow-hidden",
        !panel && "border-t border-border",
        panel && !narrow && "border-t border-border",
      )}
    >
      {showingList && (
        <PanelFileList
          bot={bot}
          folder={folder}
          folderKey={folderKey}
          onOpenFolder={(path) => setFolder(path)}
          onOpenFile={(path) => open(path, "keep")}
          writable={props.writable}
          onUpload={() => picker.current?.click()}
          renaming={renaming}
          onRenamed={move}
          making={making}
          onMade={create}
          menu={menu}
          className="@[560px]/panel:hidden"
        />
      )}
      {showDesktopTree && (
        <aside
          aria-label={`${bot.name}'s files`}
          style={{ width: Math.min(explorer.width, 240) }}
          className={cn(
            "flex shrink-0 flex-col border-r border-border",
            panel && "hidden @[560px]/panel:flex",
          )}
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
            <IconButton
              icon={SidebarSimpleIcon}
              label="Hide files"
              onClick={() => setExplorer({ open: false })}
              className="size-7 rounded-sm hover:bg-hover"
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
      {!showingList && (
        <SpadeEditor
          root={root}
          bot={bot}
          layout={layout}
          onLayoutChange={change}
          current={current}
          writable={props.writable}
          onDownload={download}
          compact={narrow}
          chromeClassName={panel ? "@max-[559px]/panel:hidden" : undefined}
          explorerToggle={
            showDesktopTree || narrow ? undefined : (
              <IconButton
                icon={SidebarSimpleIcon}
                label="Show files"
                onClick={() => setExplorer({ open: true })}
                className="ml-1 size-7 shrink-0 rounded-sm hover:bg-hover"
              />
            )
          }
        />
      )}
      {uploadInput}
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </div>
  );

  if (panel) {
    return (
      <section
        ref={box}
        aria-label={panelTitle}
        className="@container/panel flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      >
        <PanelSurfaceHeader
          title={panelTitle}
          onBack={onPanelBack}
          onExpand={onPanelExpand}
          actions={panelHeaderActions}
          border={showingFile}
        />
        {body}
      </section>
    );
  }

  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">{body}</div>;
}
