import { useClient, useConnectionState } from "@ace/client-react";
import { formatAge } from "@ace/ui-core";
import {
  focusedGroup,
  groupsOf,
  limits,
  moveActiveEditor,
  mruTabs,
  parseLayout,
  reopenClosed,
  storedLayout,
  type EditorLayout,
  type ExplorerState,
  type OutlineSymbol,
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
  lazy,
  Suspense,
} from "react";
import { SidebarSimpleIcon } from "@ace/icons";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import {
  Editor,
  BufferEditor,
  OpenEditors,
  createStatusStore,
  paneCapReason,
  useEditorBuffers,
  useFileOutline,
  useStatusReport,
  type EditorCompareProps,
  type BufferEditorProps,
  type EditorViewerProps,
  type StatusNotice,
  type StatusStore,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { useEditorAnnotations } from "@/features/editor";
import { roomLimits } from "@/lib/shell-room.ts";
import { editorLineHeight, useEditorPreferences } from "@/lib/editor-preferences.ts";
import { mentionInComposer } from "@/lib/composer-insert.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { keyboardEnv } from "@/lib/keybindings.ts";
import {
  requestReveal,
  settleReveal,
  useReveal,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { contentSearchStore } from "../files/content-search-store.ts";
import { onRevealInExplorer } from "../files/file-tree-editor.ts";
import { openInEditorPanel, type OpenInEditorPanelOptions } from "../files/open-file.ts";
import { useRecentFilesStore } from "../files/files-state.ts";
import { MentionSelection } from "../files/mention-selection.tsx";
import { quickOpen } from "../files/quick-open-store.ts";
import {
  changeNotice,
  nextChange,
  providerOf,
  stepAgentChange,
  type ChangeStop,
  type TreeMark,
} from "./agent-changes.ts";
import { agentBlocksOf, liveGutterFor } from "./gutter-store.ts";
import type { RowMark } from "../files/file-tree-row.tsx";
import {
  allTabs,
  closeEditors,
  confirmClose,
  keepTypedPreviews,
  saveAll,
  saveFile,
  saveQueued,
  showPath,
  splitFocused,
  unsavedOf,
  type EditorActionsHost,
  type SaveProblem,
} from "./editor-actions.ts";
import { explorerWidth, roomAsk } from "./editor-room.ts";
import { CheckoutGone, useCheckoutGone } from "./checkout-gone.tsx";
import { EditorExplorer, type ExplorerOpen } from "./editor-explorer.tsx";
import type { OpenChangesRequest } from "./source-control/source-control-view.tsx";
import { EditorOutline } from "./editor-outline.tsx";
import { EditorTimeline } from "./editor-timeline.tsx";
import { GoToSymbolDialog } from "./go-to-symbol.tsx";
import type { CommitDiffTarget } from "@/lib/git-history.ts";
import { EditorTabMenuItems } from "./editor-tab-menu.tsx";
import { editorKeys, type EditorPanelCommand } from "./editor-keys.ts";
import { groupIds, openPaths } from "./editor-layout.ts";
import { draftsOf, withDrafts, withoutDrafts } from "./editor-migration.ts";
import { editorRegistry, importDrafts } from "./editor-registry.ts";
import { RecentEditors, stepRecent } from "./recent-editors.tsx";
import { EditorPanelContext, useEditorPanelSaving, usePanelAutoSave } from "./use-auto-save.ts";
import { useChangeGutter } from "./use-change-gutter.tsx";
import { useTurnReview } from "./use-turn-review.tsx";
import { ReviewIdle } from "./hunk-peek.tsx";
import { useEditorSession } from "./use-editor-session.ts";
import { sceneThrough } from "@/components/ui/rules.ts";

/*
 * The editor panel tab (docs/editor/workbench.md): the thread's explorer and editor groups over
 * the app's buffer registry, its layout stored as the tab's data. The explorer docks at the left
 * whenever it shows, at every width (never over the code); Hide files and ⌘B put it away per
 * thread, and Show files in the strip brings it back.
 */

/** The most panes beside the chat; full view holds the model's nine (`limits.groups`). */
const sidePaneCap = 4;

/** ⌘K waits this long for its second key before the palette opens after all. */
const sequenceMs = 800;

const runKeymap = (id: string) =>
  window.dispatchEvent(new CustomEvent("ace:keymap", { detail: id }));

export function EditorPanel(props: TabViewProps) {
  const threadId = props.scope;
  const client = useClient();
  const registry = editorRegistry(client);
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
  const buffers = useEditorBuffers(
    registry,
    threadId,
    carried.length ? emptyOf(layout) : layout,
    providerOf,
  );
  const session = useEditorSession(threadId, registry, buffers, layout);
  const [problem, setProblem] = useState<SaveProblem | "offline">();

  // Split right or down at the pane cap: why nothing happened, until the layout next changes.
  const [capNotice, setCapNotice] = useState<string | undefined>(undefined);
  const change = (next: EditorLayout) => {
    if (next === latest.current) return;
    latest.current = next;
    setCapNotice(undefined);
    // Drafts still on their way to the draft store ride along until it has them.
    actions.update(props.tab.key, {
      data: withDrafts(storedLayout(next, unsavedOf(host)), carried),
    });
  };
  const autoSave = usePanelAutoSave({ buffers, online, problem: setProblem });
  /** Files the person saved while offline: one set for the panel's life. */
  const [offlineSaves] = useState<NonNullable<EditorActionsHost["queued"]>>(() => new Map());
  const host: EditorActionsHost = {
    buffers,
    layout: () => latest.current,
    change,
    online: () => online,
    problem: setProblem,
    saved: (path) => autoSave.savedByHand(path),
    queued: offlineSaves,
  };
  const saving = { autoSave, save: (path: string) => saveFile(host, path) };
  const target = {
    scope: threadId,
    read: () => store.get(threadId),
    actions,
    preferred: () => store.preferred,
  };
  const open = (path: string, options: OpenInEditorPanelOptions) =>
    openInEditorPanel(target, path, options);

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
  // Every file shown is looked at, so the explorer drops its mark too.
  useEffect(() => {
    if (focused.active !== undefined) see([focused.active]);
  }, [focused.active, see]);
  const rowMarks = useMemo(() => rowMarksOf(session.treeMarks), [session.treeMarks]);

  // Saves asked for offline run once the daemon is back (spec 66): only those files.
  useEffect(() => {
    if (online && problem === "offline") void saveQueued(host);
  });

  // Layout by room (spec 5).
  const root = useRef<HTMLDivElement>(null);
  const width = useElementSize(root).width;
  // A split without room asks the docked panel to widen once per shape (spec 5).
  const onNeedRoom = useCallback(
    (needed: number) => {
      const workspace = store.get(threadId);
      const ask = roomAsk({
        needed,
        panel: {
          size: workspace.size ?? store.preferred,
          dock: workspace.dock === "bottom" ? "bottom" : "side",
          expanded: workspace.expanded,
          max: panelMax(root.current),
        },
        explorer: latest.current.explorer,
      });
      if (ask !== undefined) actions.setSize(ask, true);
    },
    [store, threadId, actions],
  );
  const gone = useCheckoutGone(threadId);
  // The explorer docks beside the code whenever it shows, never over it (spec 5).
  const explorerShown = layout.explorer.open;
  // Panes: four beside the chat, nine in full view (owner, 2026-11-21).
  const fullView = useScopeWorkspace(threadId).expanded;
  const paneCap = fullView ? limits.groups : sidePaneCap;
  /** The widest and tallest the editor area can get now: the panel widening if it can. */
  const editorRoom = () => {
    const panel = root.current?.getBoundingClientRect();
    const workspace = store.get(threadId);
    const reach = workspace.expanded ? 0 : panelMax(root.current);
    const explorerPx = latest.current.explorer.open
      ? explorerWidth(Math.max(panel?.width ?? 0, reach), latest.current.explorer.width)
      : 0;
    return {
      width: Math.max(panel?.width ?? 0, reach) - explorerPx,
      height: panel?.height ?? 0,
    };
  };
  const setExplorer = (patch: Partial<ExplorerState>) =>
    change({ ...latest.current, explorer: { ...latest.current.explorer, ...patch } });
  const [focusSearch, setFocusSearch] = useState(0);
  const [gitCompare, setGitCompare] = useState<OpenChangesRequest | undefined>(undefined);
  // Reveal in Files (the tab menu) brings the explorer out to show the file.
  useEffect(() =>
    onRevealInExplorer(threadId, () => {
      if (!latest.current.explorer.open || latest.current.explorer.side !== "files")
        change({
          ...latest.current,
          explorer: { ...latest.current.explorer, open: true, side: "files" },
        });
    }),
  );
  const fromExplorer = (path: string, how: ExplorerOpen) => {
    setGitCompare(undefined);
    open(path, {
      keep: how.how !== "preview",
      side: how.how === "side",
      line: how.line,
      column: how.column,
      length: how.length,
      focus: how.how === "keep",
    });
  };
  const openChanges = (request: OpenChangesRequest) => {
    setGitCompare(request);
    open(request.path, { keep: false, focus: true });
  };

  // The status line's left side (spec 41, 45, 66).
  const changes = session.changes;
  const notice: StatusNotice | undefined = capNotice
    ? { text: capNotice }
    : problem === "offline"
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

  // Where Next change last stopped, so the next press moves on from it.
  const lastStop = useRef<ChangeStop | undefined>(undefined);

  // ⌃Tab's list, while ⌃ is held.
  const [recent, setRecent] = useState<number | undefined>(undefined);
  const [symbolPicker, setSymbolPicker] = useState(false);
  const [commitDiff, setCommitDiff] = useState<
    { group: string; activePath: string | undefined; target: CommitDiffTarget } | undefined
  >(undefined);
  const [statusStore] = useState(createStatusStore);
  const recentTabs = mruTabs(focused);
  const pickRecent = (path: string) => {
    setRecent(undefined);
    change(showPath(latest.current, path));
  };
  const revealSymbol = useCallback(
    (groupId: string, path: string, symbol: OutlineSymbol) => {
      requestReveal(threadId, {
        path,
        group: groupId,
        line: symbol.line,
        column: Math.max(0, symbol.column - 1),
        focus: true,
      });
    },
    [threadId],
  );

  const run = (command: EditorPanelCommand) => {
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
        // Past the last pane this would make one: not beyond the cap.
        if (command === "moveEditorOn" && groupsOf(now).length >= paneCap) {
          const groups = groupsOf(now);
          if (groups.at(-1)?.id === focusedGroup(now).id) return;
        }
        return change(
          moveActiveEditor(now, command === "moveEditorOn" ? "next" : "previous", groupIds(now)),
        );
      case "splitRight":
      case "splitDown":
        if (groupsOf(now).length >= paneCap) return setCapNotice(paneCapReason(paneCap));
        return change(
          splitFocused(now, command === "splitRight" ? "right" : "down", editorRoom(), paneCap),
        );
      case "explorer":
        return setExplorer({ open: !now.explorer.open });
      case "searchFiles":
        setExplorer({ side: "search", open: true });
        return setFocusSearch((value) => value + 1);
      case "sourceControl":
        return setExplorer({ side: "source-control", open: true });
      case "nextHit":
      case "previousHit": {
        const hit = contentSearchStore(client, threadId).step(command === "nextHit" ? 1 : -1);
        if (hit) open(hit.path, { line: hit.line, column: hit.column, length: hit.length });
        return;
      }
      case "nextChange":
      case "previousChange": {
        const direction = command === "nextChange" ? 1 : -1;
        // Through the agents' blocks, line by line across open files (spec 45).
        const from = lastStop.current?.path === active ? lastStop.current : undefined;
        const stop = stepAgentChange(
          openPaths(now),
          (path) => agentBlocksOf(buffers, path),
          { path: active, line: from?.line ?? -1 },
          direction,
        );
        if (stop) {
          lastStop.current = stop;
          const next = showPath(now, stop.path);
          change(next);
          requestReveal(threadId, {
            path: stop.path,
            group: focusedGroup(next).id,
            line: stop.line + 1,
            focus: true,
          });
          return;
        }
        const path = nextChange(changes, openPaths(now), active, direction);
        if (path) change(showPath(now, path));
        return;
      }
      case "goToSymbol":
        if (active) setSymbolPicker(true);
        return;
      case "composer":
        return runKeymap("focusComposer");
    }
  };

  const keys = useMemo(() => editorKeys(keyboardEnv()), []);
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
  // Read through the store: the buffer is held after the layout syncs, later than this render.
  const focusedPath = focused.active;
  const focusedBuffer = useSyncExternalStore(buffers.subscribe, () =>
    focusedPath === undefined ? undefined : buffers.buffer(focusedPath),
  );
  const openCommitDiff = useCallback(
    (diffTarget: CommitDiffTarget) => {
      const group = focusedGroup(latest.current);
      setCommitDiff({ group: group.id, activePath: group.active, target: diffTarget });
    },
    [setCommitDiff],
  );
  const activeCommitSha =
    commitDiff && commitDiff.group === focused.id && commitDiff.activePath === focused.active
      ? commitDiff.target.sha
      : undefined;
  const explorerSections = (
    <>
      <EditorOutline
        path={focused.active}
        buffer={focusedBuffer}
        focusedGroupId={focused.id}
        statusStore={statusStore}
        open={layout.explorer.outlineOpen ?? false}
        onOpenChange={(outlineOpen) => setExplorer({ outlineOpen })}
        sort={layout.explorer.outlineSort ?? "position"}
        onSortChange={(outlineSort) => setExplorer({ outlineSort })}
        onReveal={(symbol) => {
          setCommitDiff(undefined);
          if (focused.active !== undefined) revealSymbol(focused.id, focused.active, symbol);
        }}
      />
      <EditorTimeline
        threadId={threadId}
        path={focused.active}
        open={layout.explorer.timelineOpen ?? false}
        onOpenChange={(timelineOpen) => setExplorer({ timelineOpen })}
        activeCommitSha={activeCommitSha}
        onOpenCommit={openCommitDiff}
      />
    </>
  );
  const explorer = (
    <EditorExplorer
      threadId={threadId}
      explorer={layout.explorer}
      onExplorer={setExplorer}
      current={focused.active}
      onOpen={(path, how) => {
        setCommitDiff(undefined);
        fromExplorer(path, how);
      }}
      onOpenChanges={openChanges}
      openEditors={openEditors}
      sections={explorerSections}
      focusSearch={focusSearch}
      marks={rowMarks}
    />
  );

  return (
    <div
      ref={root}
      role="presentation"
      data-part="editor-panel"
      className="relative flex h-full min-h-0 min-w-0"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {gone !== undefined ? (
        <CheckoutGone path={gone} />
      ) : (
        <>
          {explorerShown && (
            <aside
              role="complementary"
              aria-label="Explorer"
              style={{ width: explorerWidth(width, layout.explorer.width) }}
              className={`relative flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar ${sceneThrough}`}
            >
              <ResizeHandle
                label="Resize the explorer"
                edge="right"
                size={layout.explorer.width}
                min={200}
                max={360}
                onResize={(next) => setExplorer({ width: next })}
                onReset={() => setExplorer({ width: 236 })}
              />
              {explorer}
            </aside>
          )}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <EditorPanelContext value={saving}>
              <Editor
                layout={layout}
                onLayoutChange={change}
                newGroupId={groupIds(layout)}
                buffers={buffers}
                statusNotice={notice}
                onConfirmClose={(refs) => void confirmClose(host, refs)}
                renderCompare={renderCompare}
                renderGitCompare={
                  gitCompare
                    ? (path) =>
                        gitCompare.path === path ? (
                          <Suspense fallback={null}>
                            <GitDiffCompare
                              key={`${gitCompare.path}:${gitCompare.stage}`}
                              threadId={threadId}
                              path={gitCompare.path}
                              stage={gitCompare.stage}
                              oldPath={gitCompare.oldPath}
                              onOpenFile={() => setGitCompare(undefined)}
                            />
                          </Suspense>
                        ) : undefined
                    : undefined
                }
                onQuickOpen={() => quickOpen.set(() => threadId)}
                onRevealSymbol={(group, path, symbol) => {
                  setCommitDiff(undefined);
                  revealSymbol(group, path, symbol);
                }}
                renderOverlay={
                  commitDiff
                    ? (group, path) =>
                        commitDiff.group === group && commitDiff.activePath === path ? (
                          <Suspense fallback={null}>
                            <EditorCommitCompare
                              threadId={threadId}
                              target={commitDiff.target}
                              onClose={() => setCommitDiff(undefined)}
                            />
                          </Suspense>
                        ) : null
                    : undefined
                }
                statusStore={statusStore}
                renderEditor={editorFor(threadId)}
                renderViewer={viewerFor(threadId)}
                tabMenuItems={menuFor(threadId)}
                threadId={threadId}
                onNeedRoom={onNeedRoom}
                paneCap={paneCap}
                room={editorRoom}
                explorerToggle={
                  !explorerShown && (
                    <IconButton
                      label="Show files"
                      shortcut="editor.explorer"
                      size="sm"
                      icon={SidebarSimpleIcon}
                      onClick={() => setExplorer({ open: true })}
                    />
                  )
                }
              />
            </EditorPanelContext>
            {recent !== undefined && recentTabs.length > 0 && (
              <RecentEditors tabs={recentTabs} index={recent} onPick={pickRecent} />
            )}
            {symbolPicker && focused.active !== undefined && (
              <ActiveGoToSymbol
                path={focused.active}
                buffer={focusedBuffer}
                groupId={focused.id}
                statusStore={statusStore}
                onPick={(symbol) => {
                  if (focused.active !== undefined)
                    revealSymbol(focused.id, focused.active, symbol);
                }}
                onClose={() => setSymbolPicker(false)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The widest the side panel can be beside the chat: the row it shares with the chat, less the
 * chat's minimum (the panel's own `maxWidth`). Unmeasured, it can't grow.
 */
function panelMax(panel: HTMLElement | null): number {
  const row = panel?.closest('[data-part="right-panel"]')?.parentElement;
  return row ? row.clientWidth - roomLimits.mainMin : 0;
}

/** The explorer's marks in words: who, and how long ago ("Claude Code · 4m"). */
function rowMarksOf(marks: ReadonlyMap<string, TreeMark>): ReadonlyMap<string, RowMark> {
  const now = Date.now();
  const rows = new Map<string, RowMark>();
  for (const [path, { author, at }] of marks) {
    const age = formatAge(at, now);
    rows.set(path, {
      name: author.kind === "agent" ? author.agent : author.title,
      provider: providerOf(author.agent),
      age: age === "now" ? "just now" : age,
    });
  }
  return rows;
}

/** A layout with no files: the editor holds none until carried-over drafts are stored. */
function emptyOf(layout: EditorLayout): EditorLayout {
  return { ...layout, root: { kind: "group", id: focusedGroup(layout).id, tabs: [], mru: [] } };
}

// Compare and the read-only viewers are cold: their code (the Changes diff, the Files viewer)
// loads when one is first shown, never with the editor's first paint.
const EditorCompare = lazy(() =>
  import("./editor-compare.tsx").then((module) => ({ default: module.EditorCompare })),
);
const GitDiffCompare = lazy(() =>
  import("./editor-compare.tsx").then((module) => ({ default: module.GitDiffCompare })),
);
const EditorCommitCompare = lazy(() =>
  import("./editor-commit-compare.tsx").then((module) => ({ default: module.EditorCommitCompare })),
);
const ReviewSideBySide = lazy(() => import("./review-side.tsx"));
const EditorFileView = lazy(() =>
  import("./editor-file-view.tsx").then((module) => ({ default: module.EditorFileView })),
);

const renderCompare = (props: EditorCompareProps) => (
  <Suspense fallback={null}>
    <EditorCompare key={props.path} {...props} />
  </Suspense>
);

const renderers = new Map<string, (editor: BufferEditorProps) => ReactNode>();
const viewers = new Map<string, (viewer: EditorViewerProps) => ReactNode>();
const menus = new Map<string, (path: string) => ReactNode>();

/** One thread's items for its tabs' menus. */
function menuFor(threadId: string): (path: string) => ReactNode {
  let menu = menus.get(threadId);
  if (!menu) {
    menu = (path) => <EditorTabMenuItems threadId={threadId} path={path} />;
    menus.set(threadId, menu);
  }
  return menu;
}

/** One thread's editor renderer, kept so a group's editor never remounts on a re-render. */
function editorFor(threadId: string): (editor: BufferEditorProps) => ReactNode {
  let render = renderers.get(threadId);
  if (!render) {
    render = (editor) => <RevealedEditor threadId={threadId} {...editor} />;
    renderers.set(threadId, render);
  }
  return render;
}

/** One thread's read-only viewer for pictures, players and binary files, kept like the editor's. */
function viewerFor(threadId: string): (viewer: EditorViewerProps) => ReactNode {
  let render = viewers.get(threadId);
  if (!render) {
    render = (viewer) => (
      <Suspense fallback={null}>
        <EditorFileView key={viewer.path} threadId={threadId} {...viewer} />
      </Suspense>
    );
    viewers.set(threadId, render);
  }
  return render;
}

/** The editor's editor, taking the place an open asked it to reveal (spec 12–13). */
function RevealedEditor(props: BufferEditorProps & { threadId: string }) {
  const { threadId, ...editor } = props;
  const { buffer } = editor;
  const reveal = useReveal(threadId, editor.group, editor.path);
  const onRevealed = useCallback((token: number) => settleReveal(threadId, token), [threadId]);
  // Annotations ride on every group's editor; views of one file map their ranges once per edit.
  const layer = useEditorAnnotations({ threadId, path: editor.path });
  // Settings › Editor, live: every open editor reads the same device store.
  const [preferences] = useEditorPreferences();
  const look = useMemo(
    () => ({
      fontSize: preferences.fontSize,
      lineHeight: editorLineHeight(preferences),
      fontFamily: preferences.fontFamily,
      wordWrap: preferences.wordWrap,
      renderWhitespace: preferences.renderWhitespace,
      indentGuides: preferences.indentGuides,
      stickyScroll: preferences.stickyScroll,
      cursorBlinking: preferences.cursorBlinking,
    }),
    [preferences],
  );
  const saving = useEditorPanelSaving();
  const autoSave = saving?.autoSave;
  const { path } = editor;
  // The gutter's live change marks, the agents' lines and the change under a pressed mark.
  const gutter = useChangeGutter({
    threadId,
    path,
    group: editor.group,
    buffer,
  });

  // A turn under review shows its hunks inline, to keep, revert or comment on (Review in editor).
  const review = useTurnReview({
    threadId,
    path,
    group: editor.group,
    buffer,
    gutter: liveGutterFor(buffer),
    layer,
  });
  const { edited } = gutter;
  const onEdited = useCallback(() => {
    edited();
    autoSave?.edited(path);
  }, [edited, autoSave, path]);
  const onBlurred = useCallback(() => autoSave?.blurred(path), [autoSave, path]);
  return (
    <MentionSelection
      path={editor.path}
      onMention={(mention) => mentionInComposer(threadId, mention)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        role="presentation"
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => {
          if (review?.onKey(event) || gutter.onKey(event)) event.preventDefault();
        }}
      >
        {review?.idle && <ReviewIdle {...review.idle} />}
        {review?.side ? (
          <Suspense fallback={null}>
            <ReviewSideBySide {...review.side} />
          </Suspense>
        ) : (
          <BufferEditor
            {...editor}
            reveal={reveal}
            marks={gutter.marks}
            agentMarks={review ? [...gutter.agentMarks, ...review.agentMarks] : gutter.agentMarks}
            layer={layer}
            look={look}
            onMarkClick={gutter.onMarkClick}
            peek={review?.peek ?? gutter.peek}
            onEdited={onEdited}
            onBlurred={onBlurred}
            onRevealed={onRevealed}
          />
        )}
      </div>
    </MentionSelection>
  );
}

/** Hosts the ⇧⌘O Go to symbol picker on the focused buffer's cached outline. */
function ActiveGoToSymbol(props: {
  path: string;
  buffer: TextBuffer | undefined;
  groupId: string;
  statusStore: StatusStore;
  onPick(symbol: OutlineSymbol): void;
  onClose(): void;
}) {
  const report = useStatusReport(props.statusStore, props.groupId);
  const { symbols } = useFileOutline(props.buffer, report?.status.language ?? props.path);
  return (
    <GoToSymbolDialog
      path={props.path}
      symbols={symbols}
      onPick={props.onPick}
      onClose={props.onClose}
    />
  );
}

export default EditorPanel;
