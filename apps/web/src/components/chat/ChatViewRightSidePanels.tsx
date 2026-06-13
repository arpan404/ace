import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ThreadId, TurnId } from "@ace/contracts";
import { IconLayoutSidebarRight, IconLayoutSidebarRightFilled } from "@tabler/icons-react";
import {
  Code2Icon,
  DiffIcon,
  GlobeIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useRef,
  type MutableRefObject,
  type ReactNode,
  type SVGProps,
} from "react";

import { useTabStripOverflow } from "~/hooks/useTabStripOverflow";
import { type BrowserSessionStorage, type BrowserTabState } from "~/lib/browser/session";
import { cn } from "~/lib/utils";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import type { DiffReviewCommentInput } from "../DiffPanel";
import { DiffPanelHeaderSkeleton, DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SubagentPersonaIcon } from "./SubagentThreadsPanel";
import type { SubagentThread } from "./subagentThreads";

const DiffPanel = lazy(() => import("../DiffPanel"));

type RightSidePanelMode = "browser" | "diff" | "editor" | "subagent" | "summary" | "terminal";

function FullscreenExpandChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      {...props}
    >
      <path d="M15 4h5v5" />
      <path d="M9 20H4v-5" />
    </svg>
  );
}

function FullscreenRestoreChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      {...props}
    >
      <path d="M20 9h-5V4" />
      <path d="M9 20v-5H4" />
    </svg>
  );
}

interface TerminalPanelTab {
  id: string;
  label: string;
  running: boolean;
}

interface EditorPanelTab {
  id: string;
  label: string;
}

interface VisiblePanelTabEntry {
  id?: string | undefined;
  key: PanelTabOrderEntry;
  mode: RightSidePanelMode;
}

export type PanelTabOrderEntry =
  | RightSidePanelMode
  | `browser:${string}`
  | `editor:${string}`
  | `subagent:${string}`
  | `terminal:${string}`;

function panelTabOrderKey(mode: RightSidePanelMode, id?: string | null): PanelTabOrderEntry {
  if (
    id &&
    (mode === "browser" || mode === "editor" || mode === "subagent" || mode === "terminal")
  ) {
    return `${mode}:${id}`;
  }
  return mode;
}

function LocalDiffLoadingFallback() {
  return (
    <DiffPanelShell mode="sidebar" header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
}

export function LocalDiffPanel(props: {
  diffState: { filePath: string | null; open: boolean; turnId: TurnId | null };
  threadId: ThreadId;
  onAddReviewComment: (comment: DiffReviewCommentInput) => void;
  onDiffStateChange: (state: {
    filePath: string | null;
    open: boolean;
    turnId: TurnId | null;
  }) => void;
}) {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<LocalDiffLoadingFallback />}>
        <DiffPanel
          mode="sidebar"
          threadId={props.threadId}
          diffOpen={props.diffState.open}
          selectedTurnId={props.diffState.turnId}
          selectedFilePath={props.diffState.filePath}
          onSelectTurn={(turnId) => {
            props.onDiffStateChange({ open: true, turnId, filePath: null });
          }}
          onSelectWholeConversation={() => {
            props.onDiffStateChange({ open: true, turnId: null, filePath: null });
          }}
          onAddReviewComment={props.onAddReviewComment}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
}

function RouteDiffPanel(props: { threadId: ThreadId }) {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<LocalDiffLoadingFallback />}>
        <DiffPanel mode="sidebar" threadId={props.threadId} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
}

function RightSidePanelBrowserTab(props: {
  active: boolean;
  className: (active: boolean) => string;
  onClose: (tabId: string) => void;
  onSelect: (tabId: string) => void;
  suppressClickAfterDragRef: MutableRefObject<boolean>;
  tab: BrowserTabState;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Select browser tab ${props.tab.title || props.tab.url || props.tab.id}`}
            className={props.className(props.active)}
            aria-pressed={props.active}
            onClick={() => {
              if (props.suppressClickAfterDragRef.current) {
                return;
              }
              props.onSelect(props.tab.id);
            }}
          />
        }
      >
        <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
          <GlobeIcon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
          <button
            type="button"
            className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
            aria-label={`Close ${props.tab.title}`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onClose(props.tab.id);
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </span>
        <span className="max-w-48 truncate">{props.tab.title}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-96 whitespace-pre-wrap">
        {props.tab.title}
      </TooltipPopup>
    </Tooltip>
  );
}

function SortablePanelTab(props: { children: ReactNode; id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: props.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "shrink-0 touch-pan-x",
        isDragging && "z-20 opacity-70",
        isOver && !isDragging && "[&>_.group\\/tab]:bg-muted/80",
      )}
      {...attributes}
      {...listeners}
    >
      {props.children}
    </div>
  );
}

function PanelTabSeparator() {
  return <span className="h-5 w-px shrink-0 bg-border/55" aria-hidden="true" />;
}

function SortablePanelTabGroup(props: {
  children: ReactNode;
  itemIds: ReadonlyArray<string>;
  onReorder: (draggedTabId: string, targetTabId: string) => void;
}) {
  const { children, itemIds, onReorder } = props;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  if (itemIds.length <= 1) {
    return children;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={[...itemIds]} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

function RightSidePanelAddTabMenu(props: {
  browserAvailable: boolean;
  browserShortcutLabel: string | null;
  diffAvailable: boolean;
  editorShortcutLabel: string | null;
  terminalNewShortcutLabel: string | null;
  terminalShortcutLabel: string | null;
  terminalOpen: boolean;
  reviewShortcutLabel: string | null;
  reviewOpen: boolean;
  onNewBrowserTab: () => void;
  onNewEditorTab: () => void;
  onNewTerminalTab: () => void;
  onSelectMode: (mode: RightSidePanelMode) => void;
}) {
  const handleTerminalMenuClick = () => {
    if (props.terminalOpen) {
      props.onNewTerminalTab();
      props.onSelectMode("terminal");
      return;
    }
    props.onSelectMode("terminal");
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Open side panel tab"
            />
          }
        >
          <PlusIcon className="size-4.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom" align="end">
          Open side panel tab
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-[200px]">
        <MenuItem
          disabled={!props.browserAvailable}
          onClick={props.onNewBrowserTab}
          className="gap-2.5 py-1.5 text-[14px]"
        >
          <GlobeIcon className="size-4.5 opacity-70" strokeWidth={1.75} />
          <span>Browser</span>
          {props.browserShortcutLabel ? (
            <MenuShortcut className="text-muted-foreground/60">
              {props.browserShortcutLabel}
            </MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem
          disabled={!props.diffAvailable || props.reviewOpen}
          onClick={() => {
            props.onSelectMode("diff");
          }}
          className="gap-2.5 py-1.5 text-[14px]"
        >
          <DiffIcon className="size-4.5 opacity-70" strokeWidth={1.75} />
          <span>Review</span>
          {props.reviewShortcutLabel ? (
            <MenuShortcut className="text-muted-foreground/60">
              {props.reviewShortcutLabel}
            </MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem onClick={props.onNewEditorTab} className="gap-2.5 py-1.5 text-[14px]">
          <Code2Icon className="size-4.5 opacity-70" strokeWidth={1.75} />
          <span>Editor</span>
          {props.editorShortcutLabel ? (
            <MenuShortcut className="text-muted-foreground/60">
              {props.editorShortcutLabel}
            </MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem onClick={handleTerminalMenuClick} className="gap-2.5 py-1.5 text-[14px]">
          <TerminalIcon className="size-4.5 opacity-70" strokeWidth={1.75} />
          <span>Terminal</span>
          {props.terminalNewShortcutLabel ? (
            <MenuShortcut className="text-muted-foreground/60">
              {props.terminalNewShortcutLabel}
            </MenuShortcut>
          ) : null}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function RightSidePanelActionButtons(props: {
  bottomPanelAvailable: boolean;
  bottomPanelOpen: boolean;
  bottomPanelToggleTooltipLabel: string;
  floatingChatOpen: boolean;
  floatingChatTooltipWithShortcut: string;
  fullscreen: boolean;
  fullscreenTooltipWithShortcut: string;
  onToggleBottomPanel: () => void;
  onToggleFloatingChat: () => void;
  onToggleFullscreen: () => void;
  onTogglePanelVisibility: () => void;
  panelToggleTooltipLabel: string;
}) {
  return (
    <>
      {props.fullscreen ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  props.floatingChatOpen
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                aria-pressed={props.floatingChatOpen}
                aria-label={props.floatingChatTooltipWithShortcut}
                onClick={props.onToggleFloatingChat}
              />
            }
          >
            <MessageSquareIcon className="size-4.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom" align="end">
            {props.floatingChatTooltipWithShortcut}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground/78 transition-colors hover:bg-accent/70 hover:text-foreground"
              aria-label={props.fullscreenTooltipWithShortcut}
              onClick={props.onToggleFullscreen}
            />
          }
        >
          {props.fullscreen ? (
            <FullscreenRestoreChevronIcon className="size-4.5" />
          ) : (
            <FullscreenExpandChevronIcon className="size-4.5" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom" align="end">
          {props.fullscreenTooltipWithShortcut}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                props.bottomPanelOpen
                  ? "bg-accent text-foreground hover:bg-accent hover:text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
                !props.bottomPanelAvailable && "pointer-events-none opacity-45",
              )}
              disabled={!props.bottomPanelAvailable}
              aria-pressed={props.bottomPanelOpen}
              aria-label={props.bottomPanelToggleTooltipLabel}
              onClick={props.onToggleBottomPanel}
            />
          }
        >
          {props.bottomPanelOpen ? (
            <IconLayoutSidebarRightFilled className="size-5 rotate-90" />
          ) : (
            <IconLayoutSidebarRight className="size-5 rotate-90" strokeWidth={2} />
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom" align="end">
          {props.bottomPanelToggleTooltipLabel}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-pressed="true"
              aria-label={props.panelToggleTooltipLabel}
              onClick={props.onTogglePanelVisibility}
            />
          }
        >
          <IconLayoutSidebarRightFilled className="size-5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom" align="end">
          {props.panelToggleTooltipLabel}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}

export function RightSidePanelTabStrip(props: {
  activeMode: RightSidePanelMode | null;
  activeBrowserTabId: string | null;
  bottomPanelAvailable?: boolean | undefined;
  bottomPanelOpen?: boolean | undefined;
  bottomPanelToggleShortcutLabel?: string | null | undefined;
  browserSession: BrowserSessionStorage | null;
  browserAvailable: boolean;
  browserShortcutLabel: string | null;
  className?: string | undefined;
  diffAvailable: boolean;
  editorShortcutLabel: string | null;
  editorTabs: ReadonlyArray<EditorPanelTab>;
  activeEditorTabId: string | null;
  terminalShortcutLabel: string | null;
  terminalNewShortcutLabel: string | null;
  terminalOpen: boolean;
  terminalTabs: ReadonlyArray<TerminalPanelTab>;
  activeTerminalId: string;
  floatingChatShortcutLabel: string | null;
  fullscreen: boolean;
  fullscreenShortcutLabel: string | null;
  reviewShortcutLabel: string | null;
  reviewOpen: boolean;
  activeSubagentThreadId: string | null;
  floatingChatOpen: boolean;
  onBrowserTabClose: (tabId: string) => void;
  onBrowserTabReorder: (draggedTabId: string, targetTabId: string) => void;
  onBrowserTabSelect: (tabId: string) => void;
  onToggleBottomPanel?: (() => void) | undefined;
  onDiffClose: () => void;
  onEditorTabClose: (tabId: string) => void;
  onEditorTabReorder: (draggedTabId: string, targetTabId: string) => void;
  onEditorTabSelect: (tabId: string) => void;
  onTerminalClose: () => void;
  onTerminalTabClose: (terminalId: string) => void;
  onTerminalTabReorder: (draggedTerminalId: string, targetTerminalId: string) => void;
  onTerminalTabSelect: (terminalId: string) => void;
  onNewBrowserTab: () => void;
  onNewEditorTab: () => void;
  onNewTerminalTab: () => void;
  onPanelTabOrderChange: (nextVisibleOrder: ReadonlyArray<PanelTabOrderEntry>) => void;
  onSelectMode: (mode: RightSidePanelMode) => void;
  onSelectSubagentThread: (threadId: string) => void;
  onTogglePanelVisibility: () => void;
  onToggleFloatingChat: () => void;
  onToggleFullscreen: () => void;
  panelToggleShortcutLabel: string | null;
  panelTabOrder: ReadonlyArray<PanelTabOrderEntry>;
  showPanelActions?: boolean | undefined;
  showSummaryTab?: boolean | undefined;
  subagentThreads: ReadonlyArray<SubagentThread>;
}) {
  const { tabStripRef, tabsOverflow } = useTabStripOverflow<HTMLDivElement>();
  const editorTooltipLabel = props.editorShortcutLabel
    ? `Editor (${props.editorShortcutLabel})`
    : "Editor";
  const panelToggleTooltipLabel = props.panelToggleShortcutLabel
    ? `Close panel (${props.panelToggleShortcutLabel})`
    : "Close panel";
  const bottomPanelToggleTooltipLabel = !props.bottomPanelAvailable
    ? "Bottom panel is unavailable until this thread has an active project."
    : props.bottomPanelToggleShortcutLabel
      ? `Toggle bottom panel (${props.bottomPanelToggleShortcutLabel})`
      : "Toggle bottom panel";
  const floatingChatTooltipLabel = props.floatingChatOpen
    ? "Hide floating chat input"
    : "Show floating chat input";
  const floatingChatTooltipWithShortcut = props.floatingChatShortcutLabel
    ? `${floatingChatTooltipLabel} (${props.floatingChatShortcutLabel})`
    : floatingChatTooltipLabel;
  const fullscreenTooltipLabel = props.fullscreen
    ? "Exit full screen side panel"
    : "Enter full screen side panel";
  const fullscreenTooltipWithShortcut = props.fullscreenShortcutLabel
    ? `${fullscreenTooltipLabel} (${props.fullscreenShortcutLabel})`
    : fullscreenTooltipLabel;
  const suppressBrowserTabClickAfterDragRef = useRef(false);
  const tabClassName = (active: boolean, disabled = false) =>
    cn(
      "group/tab inline-flex h-8 min-w-max shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-all duration-200",
      active
        ? "bg-accent text-accent-foreground ring-1 ring-border/45"
        : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      disabled &&
        "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground ring-0 shadow-none",
    );
  const browserTabClassName = (active: boolean) => cn(tabClassName(active), "touch-none");
  const showSummaryTab = props.showSummaryTab !== false;
  const hasSubagentTabs = props.activeMode === "subagent" && props.subagentThreads.length > 0;
  const hasReviewTab = props.reviewOpen;
  const hasEditorTabs = props.editorTabs.length > 0;
  const hasTerminalTabs = props.terminalOpen && props.terminalTabs.length > 0;
  const browserTabs = props.browserSession?.tabs ?? [];
  const hasBrowserTabs = browserTabs.length > 0;
  const tabOrder = props.panelTabOrder.length > 0 ? props.panelTabOrder : ["summary"];
  const orderIndex = (key: PanelTabOrderEntry, mode: RightSidePanelMode): number => {
    const exactIndex = tabOrder.indexOf(key);
    if (exactIndex >= 0) return exactIndex;
    const modeIndex = tabOrder.indexOf(mode);
    return modeIndex >= 0 ? modeIndex : tabOrder.length;
  };
  const visibleTabEntries: VisiblePanelTabEntry[] = [
    ...(showSummaryTab ? [{ key: panelTabOrderKey("summary"), mode: "summary" as const }] : []),
    ...(hasSubagentTabs
      ? props.subagentThreads.map((thread) => ({
          id: thread.id,
          key: panelTabOrderKey("subagent", thread.id),
          mode: "subagent" as const,
        }))
      : []),
    ...(hasReviewTab ? [{ key: panelTabOrderKey("diff"), mode: "diff" as const }] : []),
    ...(hasEditorTabs
      ? props.editorTabs.map((tab) => ({
          id: tab.id,
          key: panelTabOrderKey("editor", tab.id),
          mode: "editor" as const,
        }))
      : []),
    ...(hasTerminalTabs
      ? props.terminalTabs.map((tab) => ({
          id: tab.id,
          key: panelTabOrderKey("terminal", tab.id),
          mode: "terminal" as const,
        }))
      : []),
    ...(hasBrowserTabs
      ? browserTabs.map((tab) => ({
          id: tab.id,
          key: panelTabOrderKey("browser", tab.id),
          mode: "browser" as const,
        }))
      : []),
  ].toSorted((leftEntry, rightEntry) => {
    const leftIndex = orderIndex(leftEntry.key, leftEntry.mode);
    const rightIndex = orderIndex(rightEntry.key, rightEntry.mode);
    return leftIndex - rightIndex;
  });
  return (
    <div
      className={cn(
        "flex h-12 min-w-0 shrink-0 items-center gap-2.5 border-b border-border/25 bg-background px-3.5",
        props.className,
      )}
    >
      <div
        ref={tabStripRef}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheelCapture={(event) => {
          const target = event.currentTarget;
          if (target.scrollWidth <= target.clientWidth) return;
          const delta =
            Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
          if (delta === 0) return;
          target.scrollLeft += delta;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <SortablePanelTabGroup
          itemIds={visibleTabEntries.map((entry) => entry.key)}
          onReorder={(draggedTabKey, targetTabKey) => {
            const visibleOrder = visibleTabEntries.map((entry) => entry.key);
            const draggedIndex = visibleOrder.indexOf(draggedTabKey as PanelTabOrderEntry);
            const targetIndex = visibleOrder.indexOf(targetTabKey as PanelTabOrderEntry);
            if (draggedIndex >= 0 && targetIndex >= 0 && draggedIndex !== targetIndex) {
              const nextVisibleOrder = [...visibleOrder];
              const [draggedKey] = nextVisibleOrder.splice(draggedIndex, 1);
              if (draggedKey) {
                nextVisibleOrder.splice(targetIndex, 0, draggedKey);
                props.onPanelTabOrderChange(nextVisibleOrder);
              }
            }
            window.setTimeout(() => {
              suppressBrowserTabClickAfterDragRef.current = false;
            }, 0);
          }}
        >
          {visibleTabEntries.map((entry, index) => {
            const withSeparator = (children: ReactNode) => (
              <SortablePanelTab key={entry.key} id={entry.key}>
                <div className="flex min-w-max items-center gap-1.5">
                  {index > 0 ? <PanelTabSeparator /> : null}
                  {children}
                </div>
              </SortablePanelTab>
            );

            if (entry.mode === "summary") {
              return withSeparator(
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Select summary panel"
                        className={tabClassName(props.activeMode === "summary")}
                        aria-pressed={props.activeMode === "summary"}
                        onClick={() => props.onSelectMode("summary")}
                      />
                    }
                  >
                    <ListTodoIcon className="size-4.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">Summary</span>
                  </TooltipTrigger>
                  <TooltipPopup side="bottom" align="start">
                    Summary
                  </TooltipPopup>
                </Tooltip>,
              );
            }

            if (entry.mode === "subagent") {
              const thread = props.subagentThreads.find((candidate) => candidate.id === entry.id);
              if (!thread) return null;
              return withSeparator(
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Select subagent thread ${thread.label}`}
                        className={tabClassName(
                          props.activeMode === "subagent" &&
                            props.activeSubagentThreadId === thread.id,
                        )}
                        aria-pressed={
                          props.activeMode === "subagent" &&
                          props.activeSubagentThreadId === thread.id
                        }
                        onClick={() => {
                          props.onSelectSubagentThread(thread.id);
                          props.onSelectMode("subagent");
                        }}
                      />
                    }
                  >
                    <SubagentPersonaIcon
                      className="size-4.5"
                      status={thread.status}
                      thread={thread}
                    />
                    <span className="truncate">{thread.label}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="bottom" align="start">
                    {thread.label}
                  </TooltipPopup>
                </Tooltip>,
              );
            }

            if (entry.mode === "diff") {
              return withSeparator(
                <button
                  type="button"
                  className={tabClassName(props.activeMode === "diff", !props.diffAvailable)}
                  disabled={!props.diffAvailable}
                  aria-pressed={props.activeMode === "diff"}
                  onClick={() => props.onSelectMode("diff")}
                >
                  <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
                    <DiffIcon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
                    <button
                      type="button"
                      className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
                      aria-label="Close review tab"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onDiffClose();
                      }}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </span>
                  <span className="min-w-0 truncate text-left">Review</span>
                </button>,
              );
            }

            if (entry.mode === "editor") {
              const tab = props.editorTabs.find((candidate) => candidate.id === entry.id);
              if (!tab) return null;
              return withSeparator(
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Select editor tab ${tab.label}`}
                        className={tabClassName(
                          props.activeMode === "editor" && props.activeEditorTabId === tab.id,
                        )}
                        aria-pressed={
                          props.activeMode === "editor" && props.activeEditorTabId === tab.id
                        }
                        onClick={() => props.onEditorTabSelect(tab.id)}
                      />
                    }
                  >
                    <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
                      <Code2Icon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
                      <button
                        type="button"
                        className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
                        aria-label={`Close ${tab.label}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          props.onEditorTabClose(tab.id);
                        }}
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </span>
                    <span className="min-w-0 truncate text-left">{tab.label}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="bottom" align="start">
                    {editorTooltipLabel}: {tab.label}
                  </TooltipPopup>
                </Tooltip>,
              );
            }

            if (entry.mode === "terminal") {
              const tab = props.terminalTabs.find((candidate) => candidate.id === entry.id);
              if (!tab) return null;
              return withSeparator(
                <button
                  type="button"
                  className={tabClassName(
                    props.activeMode === "terminal" && props.activeTerminalId === tab.id,
                  )}
                  aria-pressed={
                    props.activeMode === "terminal" && props.activeTerminalId === tab.id
                  }
                  onClick={() => props.onTerminalTabSelect(tab.id)}
                >
                  <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
                    <TerminalIcon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
                    <button
                      type="button"
                      className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
                      aria-label={`Close ${tab.label}`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (props.terminalTabs.length <= 1) {
                          props.onTerminalClose();
                        }
                        props.onTerminalTabClose(tab.id);
                      }}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </span>
                  <span className="min-w-0 truncate text-left">{tab.label}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full",
                      tab.running ? "size-2 bg-emerald-400" : "size-1.5 bg-border",
                    )}
                  />
                </button>,
              );
            }

            if (entry.mode === "browser") {
              const tab = browserTabs.find((candidate) => candidate.id === entry.id);
              if (!tab) return null;
              return withSeparator(
                <RightSidePanelBrowserTab
                  active={props.activeMode === "browser" && props.activeBrowserTabId === tab.id}
                  className={browserTabClassName}
                  onClose={props.onBrowserTabClose}
                  onSelect={props.onBrowserTabSelect}
                  suppressClickAfterDragRef={suppressBrowserTabClickAfterDragRef}
                  tab={tab}
                />,
              );
            }

            return null;
          })}
        </SortablePanelTabGroup>
        {tabsOverflow ? (
          <span className="size-8 shrink-0" aria-hidden="true" />
        ) : (
          <div style={{ order: 999 }}>
            <RightSidePanelAddTabMenu
              browserAvailable={props.browserAvailable}
              browserShortcutLabel={props.browserShortcutLabel}
              diffAvailable={props.diffAvailable}
              editorShortcutLabel={props.editorShortcutLabel}
              terminalNewShortcutLabel={props.terminalNewShortcutLabel}
              terminalShortcutLabel={props.terminalShortcutLabel}
              terminalOpen={props.terminalOpen}
              reviewShortcutLabel={props.reviewShortcutLabel}
              reviewOpen={props.reviewOpen}
              onNewBrowserTab={props.onNewBrowserTab}
              onNewEditorTab={props.onNewEditorTab}
              onNewTerminalTab={props.onNewTerminalTab}
              onSelectMode={props.onSelectMode}
            />
          </div>
        )}
      </div>
      {tabsOverflow ? (
        <div>
          <RightSidePanelAddTabMenu
            browserAvailable={props.browserAvailable}
            browserShortcutLabel={props.browserShortcutLabel}
            diffAvailable={props.diffAvailable}
            editorShortcutLabel={props.editorShortcutLabel}
            terminalNewShortcutLabel={props.terminalNewShortcutLabel}
            terminalShortcutLabel={props.terminalShortcutLabel}
            terminalOpen={props.terminalOpen}
            reviewShortcutLabel={props.reviewShortcutLabel}
            reviewOpen={props.reviewOpen}
            onNewBrowserTab={props.onNewBrowserTab}
            onNewEditorTab={props.onNewEditorTab}
            onNewTerminalTab={props.onNewTerminalTab}
            onSelectMode={props.onSelectMode}
          />
        </div>
      ) : null}
      {props.showPanelActions !== false ? (
        <RightSidePanelActionButtons
          bottomPanelAvailable={props.bottomPanelAvailable ?? false}
          bottomPanelOpen={props.bottomPanelOpen ?? false}
          bottomPanelToggleTooltipLabel={bottomPanelToggleTooltipLabel}
          floatingChatOpen={props.floatingChatOpen}
          floatingChatTooltipWithShortcut={floatingChatTooltipWithShortcut}
          fullscreen={props.fullscreen}
          fullscreenTooltipWithShortcut={fullscreenTooltipWithShortcut}
          onToggleBottomPanel={props.onToggleBottomPanel ?? (() => undefined)}
          onToggleFloatingChat={props.onToggleFloatingChat}
          onToggleFullscreen={props.onToggleFullscreen}
          onTogglePanelVisibility={props.onTogglePanelVisibility}
          panelToggleTooltipLabel={panelToggleTooltipLabel}
        />
      ) : null}
    </div>
  );
}
