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
  Code2Icon,
  DiffIcon,
  GlobeIcon,
  ListTodoIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Suspense, lazy, useCallback, useRef, type MutableRefObject } from "react";

import { useTabStripOverflow } from "~/hooks/useTabStripOverflow";
import { type BrowserSessionStorage, type BrowserTabState } from "~/lib/browser/session";
import { cn } from "~/lib/utils";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { DiffPanelHeaderSkeleton, DiffPanelLoadingState, DiffPanelShell } from "../DiffPanelShell";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DiffPanel = lazy(() => import("../DiffPanel"));

type RightSidePanelMode = "browser" | "diff" | "editor" | "summary";

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
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
}

export function RouteDiffPanel(props: { threadId: ThreadId }) {
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
    <button
      ref={setNodeRef}
      type="button"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={props.className(props.active, isDragging, isOver)}
      {...attributes}
      aria-pressed={props.active}
      title={props.tab.title}
      onClick={() => {
        if (props.suppressClickAfterDragRef.current) {
          return;
        }
        props.onSelect(props.tab.id);
      }}
      {...listeners}
    >
      <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
        <GlobeIcon className="size-4.5 text-muted-foreground transition-opacity group-hover/tab:opacity-0" />
        <span
          role="button"
          tabIndex={-1}
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
        </span>
      </span>
      <span className="max-w-48 truncate">{props.tab.title}</span>
    </button>
  );
}

function RightSidePanelAddTabMenu(props: {
  browserAvailable: boolean;
  browserShortcutLabel: string | null;
  diffAvailable: boolean;
  editorShortcutLabel: string | null;
  editorOpen: boolean;
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
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuItem disabled={!props.browserAvailable} onClick={props.onNewBrowserTab}>
          <GlobeIcon className="size-4" />
          <span>Browser</span>
          {props.browserShortcutLabel ? (
            <MenuShortcut>{props.browserShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem
          disabled={!props.diffAvailable || props.reviewOpen}
          onClick={() => {
            props.onSelectMode("diff");
          }}
        >
          <DiffIcon className="size-4" />
          <span>Review</span>
          {props.reviewShortcutLabel ? (
            <MenuShortcut>{props.reviewShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuItem
          disabled={props.editorOpen}
          onClick={() => {
            props.onSelectMode("editor");
          }}
        >
          <Code2Icon className="size-4" />
          <span>Editor</span>
          {props.editorShortcutLabel ? (
            <MenuShortcut>{props.editorShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
      </MenuPopup>
    </Menu>
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
  fullscreen: boolean;
  reviewShortcutLabel: string | null;
  reviewOpen: boolean;
  floatingChatOpen: boolean;
  onBrowserTabClose: (tabId: string) => void;
  onBrowserTabReorder: (draggedTabId: string, targetTabId: string) => void;
  onBrowserTabSelect: (tabId: string) => void;
  onDiffClose: () => void;
  onEditorClose: () => void;
  onNewBrowserTab: () => void;
  onSelectMode: (mode: RightSidePanelMode) => void;
  onTogglePanelVisibility: () => void;
  onToggleFloatingChat: () => void;
  onToggleFullscreen: () => void;
  panelToggleShortcutLabel: string | null;
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
  const panelToggleTooltipLabel = props.panelToggleShortcutLabel
    ? `Close panel (${props.panelToggleShortcutLabel})`
    : "Close panel";
  const suppressBrowserTabClickAfterDragRef = useRef(false);
  const tabClassName = (active: boolean, disabled = false) =>
    cn(
      "group/tab inline-flex h-9 min-w-max shrink-0 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-colors",
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent hover:text-foreground",
      disabled && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
    );
  const browserTabClassName = (active: boolean, dragging = false, over = false) =>
    cn(
      tabClassName(active),
      "touch-none",
      dragging && "z-20 opacity-70",
      over && !dragging && "bg-accent/70",
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
                  <span
                    role="button"
                    tabIndex={-1}
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
                  </span>
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
                  <span
                    role="button"
                    tabIndex={-1}
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
                  </span>
                </span>
                <span className="min-w-0 truncate text-left">Editor</span>
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="start">
                {editorTooltipLabel}
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
          reviewShortcutLabel={props.reviewShortcutLabel}
          reviewOpen={props.reviewOpen}
          onNewBrowserTab={props.onNewBrowserTab}
          onSelectMode={props.onSelectMode}
        />
      ) : null}
      {props.fullscreen ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors",
                  props.floatingChatOpen
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                aria-pressed={props.floatingChatOpen}
                aria-label={
                  props.floatingChatOpen ? "Hide floating chat input" : "Show floating chat input"
                }
                onClick={props.onToggleFloatingChat}
              />
            }
          >
            <MessageSquareIcon className="size-4.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom" align="end">
            {props.floatingChatOpen ? "Hide floating chat input" : "Show floating chat input"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={
                props.fullscreen ? "Exit full screen side panel" : "Full screen side panel"
              }
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
          {props.fullscreen ? "Exit full screen" : "Enter full screen"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={panelToggleTooltipLabel}
              onClick={props.onTogglePanelVisibility}
            />
          }
        >
          <IconLayoutSidebarRightFilled className="size-5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom" align="end">
          {panelToggleTooltipLabel}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
