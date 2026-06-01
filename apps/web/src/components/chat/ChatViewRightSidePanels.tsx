import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ThreadId, TurnId } from "@ace/contracts";
import { IconLayoutSidebarRightFilled } from "@tabler/icons-react";
import {
  BotIcon,
  Code2Icon,
  DiffIcon,
  GlobeIcon,
  ListTodoIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { Suspense, lazy, useCallback, useRef, type MutableRefObject } from "react";

import { useTabStripOverflow } from "~/hooks/useTabStripOverflow";
import { type BrowserSessionStorage, type BrowserTabState } from "~/lib/browser/session";
import { cn } from "~/lib/utils";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import type { DiffReviewCommentInput } from "../DiffPanel";
import { DiffPanelHeaderSkeleton, DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SubagentThread } from "./SubagentThreadsPanel";

const DiffPanel = lazy(() => import("../DiffPanel"));

type RightSidePanelMode = "browser" | "diff" | "editor" | "subagent" | "summary" | "terminal";

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
  className: (active: boolean, dragging?: boolean, over?: boolean) => string;
  onClose: (tabId: string) => void;
  onSelect: (tabId: string) => void;
  suppressClickAfterDragRef: MutableRefObject<boolean>;
  tab: BrowserTabState;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: props.tab.id });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={setNodeRef}
            type="button"
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={props.className(props.active, isDragging, isOver)}
            {...attributes}
            aria-pressed={props.active}
            onClick={() => {
              if (props.suppressClickAfterDragRef.current) {
                return;
              }
              props.onSelect(props.tab.id);
            }}
            {...listeners}
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

function RightSidePanelAddTabMenu(props: {
  browserAvailable: boolean;
  browserShortcutLabel: string | null;
  diffAvailable: boolean;
  editorShortcutLabel: string | null;
  editorOpen: boolean;
  terminalShortcutLabel: string | null;
  terminalOpen: boolean;
  reviewShortcutLabel: string | null;
  reviewOpen: boolean;
  onNewBrowserTab: () => void;
  onSelectMode: (mode: RightSidePanelMode) => void;
}) {
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
        <MenuItem
          disabled={props.editorOpen}
          onClick={() => {
            props.onSelectMode("editor");
          }}
          className="gap-2.5 py-1.5 text-[14px]"
        >
          <Code2Icon className="size-4.5 opacity-70" strokeWidth={1.75} />
          <span>Editor</span>
          {props.editorShortcutLabel ? (
            <MenuShortcut className="text-muted-foreground/60">
              {props.editorShortcutLabel}
            </MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem
          disabled={props.terminalOpen}
          onClick={() => {
            props.onSelectMode("terminal");
          }}
          className="gap-2.5 py-1.5 text-[14px]"
        >
          <TerminalIcon className="size-4.5 opacity-70" strokeWidth={1.75} />
          <span>Terminal</span>
          {props.terminalShortcutLabel ? (
            <MenuShortcut className="text-muted-foreground/60">
              {props.terminalShortcutLabel}
            </MenuShortcut>
          ) : null}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function RightSidePanelActionButtons(props: {
  floatingChatOpen: boolean;
  floatingChatTooltipWithShortcut: string;
  fullscreen: boolean;
  fullscreenTooltipWithShortcut: string;
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
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={props.fullscreenTooltipWithShortcut}
              onClick={props.onToggleFullscreen}
            />
          }
        >
          {props.fullscreen ? (
            <Minimize2Icon className="size-4.5" />
          ) : (
            <Maximize2Icon className="size-4.5" />
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
  activeMode: RightSidePanelMode;
  activeBrowserTabId: string | null;
  browserSession: BrowserSessionStorage | null;
  browserAvailable: boolean;
  browserShortcutLabel: string | null;
  className?: string | undefined;
  diffAvailable: boolean;
  editorShortcutLabel: string | null;
  editorOpen: boolean;
  terminalShortcutLabel: string | null;
  terminalOpen: boolean;
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
  onDiffClose: () => void;
  onEditorClose: () => void;
  onTerminalClose: () => void;
  onNewBrowserTab: () => void;
  onSelectMode: (mode: RightSidePanelMode) => void;
  onSelectSubagentThread: (threadId: string) => void;
  onTogglePanelVisibility: () => void;
  onToggleFloatingChat: () => void;
  onToggleFullscreen: () => void;
  panelToggleShortcutLabel: string | null;
  subagentThreads: ReadonlyArray<SubagentThread>;
}) {
  const { onBrowserTabReorder } = props;
  const { tabStripRef, tabsOverflow } = useTabStripOverflow<HTMLDivElement>();
  const browserTabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const reviewTooltipLabel = props.reviewShortcutLabel
    ? `Review (${props.reviewShortcutLabel})`
    : "Review";
  const editorTooltipLabel = props.editorShortcutLabel
    ? `Editor (${props.editorShortcutLabel})`
    : "Editor";
  const terminalTooltipLabel = props.terminalShortcutLabel
    ? `Terminal (${props.terminalShortcutLabel})`
    : "Terminal";
  const panelToggleTooltipLabel = props.panelToggleShortcutLabel
    ? `Close panel (${props.panelToggleShortcutLabel})`
    : "Close panel";
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
        ? "bg-accent text-accent-foreground shadow-sm shadow-black/5 ring-1 ring-border/50"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      disabled &&
        "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground ring-0 shadow-none",
    );
  const browserTabClassName = (active: boolean, dragging = false, over = false) =>
    cn(
      tabClassName(active),
      "touch-none",
      dragging && "z-20 opacity-70",
      over && !dragging && "bg-muted/80",
    );
  const handleBrowserTabDragStart = useCallback((_event: DragStartEvent) => {
    suppressBrowserTabClickAfterDragRef.current = true;
  }, []);
  const handleBrowserTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        onBrowserTabReorder(String(active.id), String(over.id));
      }
      window.setTimeout(() => {
        suppressBrowserTabClickAfterDragRef.current = false;
      }, 0);
    },
    [onBrowserTabReorder],
  );
  const handleBrowserTabDragCancel = useCallback((_event: DragCancelEvent) => {
    window.setTimeout(() => {
      suppressBrowserTabClickAfterDragRef.current = false;
    }, 0);
  }, []);

  return (
    <div
      className={cn("flex h-12 shrink-0 items-center gap-2.5 bg-card/80 px-3.5", props.className)}
    >
      <div
        ref={tabStripRef}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden scroll-px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
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
        </Tooltip>
        {props.subagentThreads.length > 0 ? (
          <>
            <span className="h-5 w-px shrink-0 bg-border/70" />
            {props.subagentThreads.map((thread) => (
              <Tooltip key={thread.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
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
                  <BotIcon
                    className={cn(
                      "size-4.5 shrink-0",
                      thread.status === "failed"
                        ? "text-destructive"
                        : thread.status === "completed"
                          ? "text-emerald-500"
                          : "text-sky-500",
                    )}
                  />
                  <span className="truncate">{thread.label}</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom" align="start">
                  {thread.label}
                </TooltipPopup>
              </Tooltip>
            ))}
          </>
        ) : null}
        {props.reviewOpen ? (
          <>
            <span className="h-5 w-px shrink-0 bg-border/70" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={tabClassName(props.activeMode === "diff", !props.diffAvailable)}
                    disabled={!props.diffAvailable}
                    aria-pressed={props.activeMode === "diff"}
                    onClick={() => props.onSelectMode("diff")}
                  />
                }
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
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="start">
                {reviewTooltipLabel}
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        {props.editorOpen ? (
          <>
            <span className="h-5 w-px shrink-0 bg-border/70" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={tabClassName(props.activeMode === "editor")}
                    aria-pressed={props.activeMode === "editor"}
                    onClick={() => props.onSelectMode("editor")}
                  />
                }
              >
                <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
                  <Code2Icon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
                  <button
                    type="button"
                    className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
                    aria-label="Close editor tab"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onEditorClose();
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </span>
                <span className="min-w-0 truncate text-left">Editor</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="start">
                {editorTooltipLabel}
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        {props.terminalOpen ? (
          <>
            <span className="h-5 w-px shrink-0 bg-border/70" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={tabClassName(props.activeMode === "terminal")}
                    aria-pressed={props.activeMode === "terminal"}
                    onClick={() => props.onSelectMode("terminal")}
                  />
                }
              >
                <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
                  <TerminalIcon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
                  <button
                    type="button"
                    className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
                    aria-label="Close terminal tab"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onTerminalClose();
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </span>
                <span className="min-w-0 truncate text-left">Terminal</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="start">
                {terminalTooltipLabel}
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        {props.browserSession?.tabs.length ? (
          <span className="h-5 w-px shrink-0 bg-border/70" />
        ) : null}
        {props.browserSession?.tabs.length ? (
          <DndContext
            sensors={browserTabSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleBrowserTabDragStart}
            onDragEnd={handleBrowserTabDragEnd}
            onDragCancel={handleBrowserTabDragCancel}
          >
            <SortableContext
              items={props.browserSession.tabs.map((tab) => tab.id)}
              strategy={horizontalListSortingStrategy}
            >
              {props.browserSession.tabs.map((tab) => (
                <RightSidePanelBrowserTab
                  key={tab.id}
                  active={props.activeMode === "browser" && props.activeBrowserTabId === tab.id}
                  className={browserTabClassName}
                  onClose={props.onBrowserTabClose}
                  onSelect={props.onBrowserTabSelect}
                  suppressClickAfterDragRef={suppressBrowserTabClickAfterDragRef}
                  tab={tab}
                />
              ))}
            </SortableContext>
          </DndContext>
        ) : null}
        {tabsOverflow ? (
          <span className="size-8 shrink-0" aria-hidden="true" />
        ) : (
          <RightSidePanelAddTabMenu
            browserAvailable={props.browserAvailable}
            browserShortcutLabel={props.browserShortcutLabel}
            diffAvailable={props.diffAvailable}
            editorShortcutLabel={props.editorShortcutLabel}
            editorOpen={props.editorOpen}
            terminalShortcutLabel={props.terminalShortcutLabel}
            terminalOpen={props.terminalOpen}
            reviewShortcutLabel={props.reviewShortcutLabel}
            reviewOpen={props.reviewOpen}
            onNewBrowserTab={props.onNewBrowserTab}
            onSelectMode={props.onSelectMode}
          />
        )}
      </div>
      {tabsOverflow ? (
        <RightSidePanelAddTabMenu
          browserAvailable={props.browserAvailable}
          browserShortcutLabel={props.browserShortcutLabel}
          diffAvailable={props.diffAvailable}
          editorShortcutLabel={props.editorShortcutLabel}
          editorOpen={props.editorOpen}
          terminalShortcutLabel={props.terminalShortcutLabel}
          terminalOpen={props.terminalOpen}
          reviewShortcutLabel={props.reviewShortcutLabel}
          reviewOpen={props.reviewOpen}
          onNewBrowserTab={props.onNewBrowserTab}
          onSelectMode={props.onSelectMode}
        />
      ) : null}
      <RightSidePanelActionButtons
        floatingChatOpen={props.floatingChatOpen}
        floatingChatTooltipWithShortcut={floatingChatTooltipWithShortcut}
        fullscreen={props.fullscreen}
        fullscreenTooltipWithShortcut={fullscreenTooltipWithShortcut}
        onToggleFloatingChat={props.onToggleFloatingChat}
        onToggleFullscreen={props.onToggleFullscreen}
        onTogglePanelVisibility={props.onTogglePanelVisibility}
        panelToggleTooltipLabel={panelToggleTooltipLabel}
      />
    </div>
  );
}
