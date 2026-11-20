import { useClient, useConnectionState } from "@ace/client-react";
import { ProviderKind } from "@ace/protocol";
import { providerDisplayName } from "@ace/ui-core";
import {
  focusedGroup,
  groupsOf,
  moveActiveEditor,
  mruTabs,
  parseLayout,
  reopenClosed,
  storedLayout,
  type EditorLayout,
  type ExplorerState,
} from "@ace/ui-core/editor-workbench";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
} from "react";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import {
  Deck,
  DeckEditor,
  OpenEditors,
  compactBelowPx,
  useDeckBuffers,
  type DeckEditorProps,
  type DeckViewerProps,
  type StatusNotice,
} from "@/features/editor-workbench/index.ts";
import { useEditorAnnotations } from "@/features/editor";
import { cn } from "@/lib/cn.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { keyboardEnv } from "@/lib/keybindings.ts";
import {
  settleReveal,
  useReveal,
  useWorkspaceActions,
  useWorkspaceStore,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { contentSearchStore } from "../files/content-search-store.ts";
import { onRevealInExplorer } from "../files/file-tree-deck.ts";
import { openInDeck, type OpenInDeckOptions } from "../files/open-file.ts";
import { useRecentFilesStore } from "../files/files-state.ts";
import { useChangeMarks } from "../files/use-change-marks.ts";
import { quickOpen } from "../files/quick-open-store.ts";
import { changeNotice, nextChange } from "./agent-changes.ts";
import {
  allTabs,
  closeEditors,
  confirmClose,
  keepTypedPreviews,
  saveAll,
  saveFile,
  showPath,
  splitFocused,
  unsavedOf,
  type DeckActionsHost,
  type SaveProblem,
} from "./deck-actions.ts";
import { DeckExplorer, type ExplorerOpen } from "./deck-explorer.tsx";
import { DeckFileView } from "./deck-file-view.tsx";
import { DeckTabMenuItems } from "./deck-tab-menu.tsx";
import { deckKeys, type DeckCommand } from "./deck-keys.ts";
import { groupIds, openPaths } from "./deck-layout.ts";
import { draftsOf, withoutDrafts } from "./deck-migration.ts";
import { deckRegistry, importDrafts } from "./deck-registry.ts";
import { RecentEditors, stepRecent } from "./recent-editors.tsx";
import { useDeckSession } from "./use-deck-session.ts";

/*
 * The Deck panel tab (docs/editor/workbench.md): the thread's explorer and editor groups over
 * the app's buffer registry, its layout stored as the tab's data. Under 760px it is compact:
 * one group shows and the explorer steps aside behind "Show files", laid over the editor while
 * open. From 760px the explorer docks at the left.
 */

const providerOf = (agent: string) =>
  ProviderKind.options.find((kind) => providerDisplayName(kind) === agent);

/** ⌘K waits this long for its second key before the palette opens after all. */
const sequenceMs = 800;

const runKeymap = (id: string) =>
  window.dispatchEvent(new CustomEvent("ace:keymap", { detail: id }));

export function DeckPanel(props: TabViewProps) {
  const threadId = props.scope;
  const client = useClient();
  const registry = deckRegistry(client);
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(threadId);
  const online = useConnectionState() === "ready";
  const stored = useMemo(() => parseLayout(props.tab.data, "g1"), [props.tab.data]);
  const carried = useMemo(() => draftsOf(stored), [stored]);
  const layout = useMemo(() => withoutDrafts(stored), [stored]);
  const latest = useRef(layout);
  // Handlers read the layout as it is now, even between a change and its render.
  useLayoutEffect(() => {
    latest.current = layout;
  }, [layout]);
  const buffers = useDeckBuffers(
    registry,
    threadId,
    carried.length ? emptyOf(layout) : layout,
    providerOf,
  );
  const session = useDeckSession(threadId, registry, buffers, layout);
  const [problem, setProblem] = useState<SaveProblem | "offline">();

  const change = (next: EditorLayout) => {
    if (next === latest.current) return;
    latest.current = next;
    actions.update(props.tab.key, { data: storedLayout(next, unsavedOf(host)) });
  };
  const host: DeckActionsHost = {
    buffers,
    layout: () => latest.current,
    change,
    online: () => online,
    problem: setProblem,
  };
  const target = {
    scope: threadId,
    read: () => store.get(threadId),
    actions,
    preferred: () => store.preferred,
  };
  const open = (path: string, options: OpenInDeckOptions) => openInDeck(target, path, options);

  // Drafts carried over from old per-file tabs reach the draft store before their files open.
  useEffect(() => {
    if (carried.length === 0) return;
    let live = true;
    void importDrafts(threadId, carried).then(
      () => live && actions.update(props.tab.key, { data: withoutDrafts(stored) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [carried, stored, threadId, actions, props.tab.key]);

  // Typing in a preview keeps it (spec 10).
  const dirtyPreviews = useSyncExternalStore(buffers.subscribe, () =>
    groupsOf(layout)
      .flatMap((group) =>
        group.tabs.filter((tab) => tab.preview && buffers.snapshot(tab.path)?.dirty),
      )
      .map((tab) => tab.path)
      .join("\n"),
  );
  useEffect(() => {
    if (dirtyPreviews) change(keepTypedPreviews(latest.current, buffers));
  });

  // The focused group's shown file is looked at: its agent mark goes, and quick open lists it
  // among recent files.
  const focused = focusedGroup(layout);
  const recentFiles = useRecentFilesStore();
  useEffect(() => {
    if (focused.active !== undefined) recentFiles.remember(threadId, focused.active);
  }, [recentFiles, threadId, focused.active]);
  const { see } = session;
  const lookedAt =
    focused.active !== undefined && session.changes.has(focused.active)
      ? focused.active
      : undefined;
  useEffect(() => {
    if (lookedAt !== undefined) see([lookedAt]);
  }, [lookedAt, see]);

  // Saves asked for offline run once the daemon is back (spec 66).
  useEffect(() => {
    if (online && problem === "offline") void saveAll(host);
  });

  // Layout by room (spec 5).
  const root = useRef<HTMLDivElement>(null);
  const width = useElementSize(root).width;
  const compact = width > 0 && width < compactBelowPx;
  const [overlay, setOverlay] = useState(() => openPaths(layout).length === 0);
  const explorerShown = compact ? overlay : layout.explorer.open;
  const setExplorer = (patch: Partial<ExplorerState>) =>
    change({ ...latest.current, explorer: { ...latest.current.explorer, ...patch } });
  const [focusSearch, setFocusSearch] = useState(0);
  // Reveal in Files (the tab menu) brings the explorer out to show the file.
  useEffect(() =>
    onRevealInExplorer(threadId, () => {
      if (compact) setOverlay(true);
      else if (!latest.current.explorer.open || latest.current.explorer.side !== "files")
        change({
          ...latest.current,
          explorer: { ...latest.current.explorer, open: true, side: "files" },
        });
    }),
  );
  const fromExplorer = (path: string, how: ExplorerOpen) => {
    open(path, {
      keep: how.how !== "preview",
      side: how.how === "tab",
      line: how.line,
      column: how.column,
      length: how.length,
      focus: how.how === "keep",
    });
    if (compact) setOverlay(false);
  };

  // The status line's left side (spec 41, 45, 66).
  const changes = session.changes;
  const notice: StatusNotice | undefined =
    problem === "offline"
      ? { text: "Saving when the daemon reconnects" }
      : problem
        ? {
            text: `Couldn't save ${problem.path.split("/").at(-1)}. ${problem.message}`,
            action: { label: "Try again", run: () => void saveFile(host, problem.path) },
          }
        : changeNotice(changes)
          ? {
              text: changeNotice(changes) ?? "",
              action: { label: "Next change", run: () => run("nextChange") },
            }
          : !online
            ? { text: "Offline. Edits are kept on this device." }
            : undefined;

  // ⌃Tab's list, while ⌃ is held.
  const [recent, setRecent] = useState<number | undefined>(undefined);
  const recentTabs = mruTabs(focused);
  const pickRecent = (path: string) => {
    setRecent(undefined);
    change(showPath(latest.current, path));
  };

  const run = (command: DeckCommand) => {
    const now = latest.current;
    const group = focusedGroup(now);
    const active = group.active;
    switch (command) {
      case "save":
        if (active) void saveFile(host, active);
        return;
      case "saveAll":
        return void saveAll(host);
      case "close":
        if (active) void closeEditors(host, [{ group: group.id, path: active }]);
        return;
      case "closeAll":
        return void closeEditors(host, allTabs(now));
      case "reopen":
        return change(reopenClosed(now));
      case "recent":
      case "recentBack":
        return setRecent((index) =>
          stepRecent(index ?? 0, command === "recent" ? 1 : -1, recentTabs.length),
        );
      case "moveEditorBack":
      case "moveEditorOn":
        return change(
          moveActiveEditor(now, command === "moveEditorOn" ? "next" : "previous", groupIds(now)),
        );
      case "splitRight":
        return change(splitFocused(now, "right"));
      case "splitDown":
        return change(splitFocused(now, "down"));
      case "explorer":
        return compact ? setOverlay((shown) => !shown) : setExplorer({ open: !now.explorer.open });
      case "searchFiles":
        if (compact) setOverlay(true);
        setExplorer({ side: "search", ...(compact ? {} : { open: true }) });
        return setFocusSearch((value) => value + 1);
      case "nextHit":
      case "previousHit": {
        const hit = contentSearchStore(client, threadId).step(command === "nextHit" ? 1 : -1);
        if (hit) open(hit.path, { line: hit.line, column: hit.column, length: hit.length });
        return;
      }
      case "nextChange":
      case "previousChange": {
        const path = nextChange(changes, openPaths(now), active, command === "nextChange" ? 1 : -1);
        if (path) change(showPath(now, path));
        return;
      }
      case "composer":
        if (compact && overlay) return setOverlay(false);
        return runKeymap("focusComposer");
    }
  };

  const keys = useMemo(() => deckKeys(keyboardEnv()), []);
  const sequence = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const command = keys.press(event.nativeEvent);
    clearTimeout(sequence.current);
    if (keys.waiting()) {
      // ⌘K: the second key decides; with none, the palette opens as it would elsewhere.
      event.preventDefault();
      sequence.current = setTimeout(() => {
        keys.cancel();
        runKeymap("palette");
      }, sequenceMs);
      return;
    }
    if (!command) return;
    if (command === "composer" && recent !== undefined) {
      event.preventDefault();
      return setRecent(undefined);
    }
    event.preventDefault();
    event.stopPropagation();
    run(command);
  };
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (recent === undefined || event.key !== "Control") return;
    const tab = recentTabs[recent];
    if (tab) pickRecent(tab.path);
    else setRecent(undefined);
  };

  const openEditors = (
    <OpenEditors
      layout={layout}
      onLayoutChange={change}
      newGroupId={groupIds(layout)}
      buffers={buffers}
      onConfirmClose={(refs) => void confirmClose(host, refs)}
      onSaveAll={() => void saveAll(host)}
      open={layout.explorer.openEditors}
      onOpenChange={(unfolded) => setExplorer({ openEditors: unfolded })}
    />
  );
  const explorer = (
    <DeckExplorer
      threadId={threadId}
      explorer={layout.explorer}
      onExplorer={setExplorer}
      current={focused.active}
      onOpen={fromExplorer}
      openEditors={openEditors}
      focusSearch={focusSearch}
    />
  );

  return (
    <div
      ref={root}
      role="presentation"
      data-part="deck-panel"
      className="relative flex h-full min-h-0 min-w-0"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {explorerShown && (
        <aside
          role="complementary"
          aria-label="Explorer"
          style={{ width: compact ? Math.min(layout.explorer.width, 320) : layout.explorer.width }}
          className={cn(
            "relative flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar",
            compact &&
              "fx-panel-in absolute inset-y-0 left-0 z-[4] max-w-[85%] shadow-[12px_0_32px_rgb(0_0_0/0.22)]",
          )}
        >
          {!compact && (
            <ResizeHandle
              label="Resize the explorer"
              edge="right"
              size={layout.explorer.width}
              min={200}
              max={360}
              onResize={(next) => setExplorer({ width: next })}
              onReset={() => setExplorer({ width: 236 })}
            />
          )}
          {explorer}
        </aside>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <Deck
          layout={layout}
          onLayoutChange={change}
          newGroupId={groupIds(layout)}
          buffers={buffers}
          statusNotice={notice}
          onConfirmClose={(refs) => void confirmClose(host, refs)}
          onCompare={(path) =>
            actions.open({ kind: "changes", data: { scope: "working-tree", path } })
          }
          onQuickOpen={() => quickOpen.set(() => threadId)}
          renderEditor={editorFor(threadId)}
          renderViewer={viewerFor(threadId)}
          tabMenuItems={menuFor(threadId)}
          explorerToggle={
            <button
              type="button"
              aria-expanded={overlay}
              onClick={() => setOverlay((shown) => !shown)}
              className="mr-1 h-6 shrink-0 rounded-sm px-2 text-xs font-medium text-muted-foreground focus-ring-inset hover:bg-hover hover:text-foreground"
            >
              {overlay ? "Hide files" : "Show files"}
            </button>
          }
        />
        {recent !== undefined && recentTabs.length > 0 && (
          <RecentEditors tabs={recentTabs} index={recent} onPick={pickRecent} />
        )}
      </div>
    </div>
  );
}

/** A layout with no files: the Deck holds none until carried-over drafts are stored. */
function emptyOf(layout: EditorLayout): EditorLayout {
  return { ...layout, root: { kind: "group", id: focusedGroup(layout).id, tabs: [], mru: [] } };
}

const renderers = new Map<string, (editor: DeckEditorProps) => ReactNode>();
const viewers = new Map<string, (viewer: DeckViewerProps) => ReactNode>();
const menus = new Map<string, (path: string) => ReactNode>();

/** One thread's items for its tabs' menus. */
function menuFor(threadId: string): (path: string) => ReactNode {
  let menu = menus.get(threadId);
  if (!menu) {
    menu = (path) => <DeckTabMenuItems threadId={threadId} path={path} />;
    menus.set(threadId, menu);
  }
  return menu;
}

/** One thread's editor renderer, kept so a group's editor never remounts on a re-render. */
function editorFor(threadId: string): (editor: DeckEditorProps) => ReactNode {
  let render = renderers.get(threadId);
  if (!render) {
    render = (editor) => <RevealedEditor threadId={threadId} {...editor} />;
    renderers.set(threadId, render);
  }
  return render;
}

/** One thread's read-only viewer for pictures, players and binary files, kept like the editor's. */
function viewerFor(threadId: string): (viewer: DeckViewerProps) => ReactNode {
  let render = viewers.get(threadId);
  if (!render) {
    render = (viewer) => <DeckFileView key={viewer.path} threadId={threadId} {...viewer} />;
    viewers.set(threadId, render);
  }
  return render;
}

/** The Deck's editor, taking the place an open asked it to reveal (spec 12–13). */
function RevealedEditor(props: DeckEditorProps & { threadId: string }) {
  const { threadId, ...editor } = props;
  const { buffer } = editor;
  const reveal = useReveal(threadId, editor.group, editor.path);
  const subscribe = useCallback((changed: () => void) => buffer.subscribe(changed), [buffer]);
  const version = useSyncExternalStore(subscribe, () => buffer.snapshot().version);
  const marks = useChangeMarks(threadId, editor.path, version);
  const onRevealed = useCallback((token: number) => settleReveal(threadId, token), [threadId]);
  // Annotations ride on every group's editor; views of one file map their ranges once per edit.
  const layer = useEditorAnnotations({ threadId, path: editor.path });
  return (
    <DeckEditor {...editor} reveal={reveal} marks={marks} layer={layer} onRevealed={onRevealed} />
  );
}

export default DeckPanel;
