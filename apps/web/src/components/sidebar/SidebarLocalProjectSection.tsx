import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEventHandler,
  memo,
  useMemo,
} from "react";
import { type GitStatusResult, type ProjectId, type ThreadId } from "@ace/contracts";
import { type SidebarThreadSortOrder } from "@ace/contracts/settings";
import { IconPin, IconPinFilled, IconPinnedOff } from "@tabler/icons-react";
import { ChevronRightIcon, SquarePenIcon } from "lucide-react";

import { ProjectAvatar } from "../ProjectAvatar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { type SidebarThreadRowProps, SidebarThreadRow } from "./SidebarThreadRow";
import { type SortableProjectHandleProps } from "./SortableProjectItem";
import { deriveSidebarLocalProjectRenderState } from "./localProjectRenderState";
import { useProjectById, useSidebarThreadSummariesByProjectId } from "../../storeSelectors";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";

type BoardDragProps = NonNullable<SidebarThreadRowProps["boardDrag"]>;

export interface SidebarLocalProjectSectionProps {
  readonly activeRouteConnectionUrl: string;
  readonly activeSidebarRouteThreadId: ThreadId | null;
  readonly appSettingsConfirmThreadArchive: boolean;
  readonly confirmArchiveButtonRefs: SidebarThreadRowProps["confirmArchiveButtonRefs"];
  readonly confirmingArchiveThreadId: ThreadId | null;
  readonly connectionUrl: string;
  readonly createBoardThreadRowDragProps: (thread: {
    connectionUrl: string | null;
    threadId: ThreadId;
  }) => BoardDragProps;
  readonly dragHandleProps: SortableProjectHandleProps | null;
  readonly handleMultiSelectContextMenu: SidebarThreadRowProps["handleMultiSelectContextMenu"];
  readonly handleProjectContextMenu: (
    projectId: ProjectId,
    position: { x: number; y: number },
  ) => Promise<void>;
  readonly handleProjectTitleClick: (
    event: MouseEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  readonly handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  readonly handleProjectTitlePointerDownCapture: PointerEventHandler<HTMLButtonElement>;
  readonly handleStartNewThreadForProject: (projectId: ProjectId) => void;
  readonly handleThreadClick: SidebarThreadRowProps["handleThreadClick"];
  readonly handleThreadContextMenu: SidebarThreadRowProps["handleThreadContextMenu"];
  readonly isPinned: boolean;
  readonly jumpLabelByThreadId: ReadonlyMap<ThreadId, string>;
  readonly markProjectContextMenuPending: () => void;
  readonly newThreadShortcutLabel: string | null;
  readonly onCollapseThreadList: (projectId: ProjectId) => void;
  readonly onExpandThreadList: (projectId: ProjectId) => void;
  readonly onTogglePinnedProject: (projectId: ProjectId) => void;
  readonly onTogglePinnedThread: (threadId: ThreadId) => void;
  readonly openPrLink: SidebarThreadRowProps["openPrLink"];
  readonly pinnedThreadIdSet: ReadonlySet<ThreadId>;
  readonly prByThreadId: ReadonlyMap<ThreadId, GitStatusResult["pr"]>;
  readonly prefetchThreadHistory: SidebarThreadRowProps["prefetchThreadHistory"];
  readonly projectId: ProjectId;
  readonly renamingCommittedRef: SidebarThreadRowProps["renamingCommittedRef"];
  readonly renamingInputRef: SidebarThreadRowProps["renamingInputRef"];
  readonly renamingThreadId: ThreadId | null;
  readonly renamingTitle: string;
  readonly routeThreadId: ThreadId | null;
  readonly selectedThreadIds: ReadonlySet<ThreadId>;
  readonly setConfirmingArchiveThreadId: SidebarThreadRowProps["setConfirmingArchiveThreadId"];
  readonly setRenamingTitle: SidebarThreadRowProps["setRenamingTitle"];
  readonly showThreadJumpHints: boolean;
  readonly threadRevealCount: number;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly clearSelection: SidebarThreadRowProps["clearSelection"];
  readonly commitRename: SidebarThreadRowProps["commitRename"];
  readonly cancelRename: SidebarThreadRowProps["cancelRename"];
  readonly attemptArchiveThread: SidebarThreadRowProps["attemptArchiveThread"];
  readonly navigateToThread: SidebarThreadRowProps["navigateToThread"];
}

export const SidebarLocalProjectSection = memo(function SidebarLocalProjectSection(
  props: SidebarLocalProjectSectionProps,
) {
  const project = useProjectById(props.projectId);
  const allProjectThreads = useSidebarThreadSummariesByProjectId(props.projectId);
  const projectExpanded = useUiStateStore(
    (state) => state.projectExpandedById[props.projectId] ?? true,
  );
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  const visibleProjectThreads = useMemo(
    () => allProjectThreads.filter((thread) => thread.archivedAt === null),
    [allProjectThreads],
  );
  const projectListThreads = useMemo(
    () => visibleProjectThreads.filter((thread) => !props.pinnedThreadIdSet.has(thread.id)),
    [props.pinnedThreadIdSet, visibleProjectThreads],
  );
  const renderState = useMemo(
    () =>
      deriveSidebarLocalProjectRenderState({
        activeThreadId: props.activeSidebarRouteThreadId ?? undefined,
        projectExpanded,
        projectListThreads,
        revealStep: 5,
        threadLastVisitedAtById,
        unsortedProjectThreads: visibleProjectThreads,
        visibleThreadCount: props.threadRevealCount,
        threadSortOrder: props.threadSortOrder,
      }),
    [
      props.activeSidebarRouteThreadId,
      props.threadRevealCount,
      props.threadSortOrder,
      projectExpanded,
      projectListThreads,
      threadLastVisitedAtById,
      visibleProjectThreads,
    ],
  );

  if (!project) {
    return null;
  }

  const shouldRenderThreadPanel =
    renderState.shouldShowThreadPanel &&
    (renderState.showEmptyThreadState ||
      renderState.renderedThreadIds.length > 0 ||
      renderState.hasHiddenThreads ||
      renderState.canCollapseThreadList);
  const isDraggable = props.dragHandleProps !== null;

  const renderThreadRow = (threadId: ThreadId) => {
    const boardDrag = props.createBoardThreadRowDragProps({
      connectionUrl: props.connectionUrl,
      threadId,
    });
    return (
      <SidebarThreadRow
        key={threadId}
        threadId={threadId}
        orderedProjectThreadIds={renderState.orderedProjectThreadIds}
        routeThreadId={props.routeThreadId}
        activeRouteConnectionUrl={props.activeRouteConnectionUrl}
        connectionUrl={props.connectionUrl}
        selectedThreadIds={props.selectedThreadIds}
        showThreadJumpHints={props.showThreadJumpHints}
        jumpLabel={props.jumpLabelByThreadId.get(threadId) ?? null}
        appSettingsConfirmThreadArchive={props.appSettingsConfirmThreadArchive}
        isPinned={props.pinnedThreadIdSet.has(threadId)}
        boardDrag={boardDrag}
        renamingThreadId={props.renamingThreadId}
        renamingTitle={props.renamingTitle}
        setRenamingTitle={props.setRenamingTitle}
        renamingInputRef={props.renamingInputRef}
        renamingCommittedRef={props.renamingCommittedRef}
        confirmingArchiveThreadId={props.confirmingArchiveThreadId}
        setConfirmingArchiveThreadId={props.setConfirmingArchiveThreadId}
        confirmArchiveButtonRefs={props.confirmArchiveButtonRefs}
        handleThreadClick={props.handleThreadClick}
        navigateToThread={props.navigateToThread}
        prefetchThreadHistory={props.prefetchThreadHistory}
        handleMultiSelectContextMenu={props.handleMultiSelectContextMenu}
        handleThreadContextMenu={props.handleThreadContextMenu}
        clearSelection={props.clearSelection}
        commitRename={props.commitRename}
        cancelRename={props.cancelRename}
        attemptArchiveThread={props.attemptArchiveThread}
        onTogglePinnedThread={props.onTogglePinnedThread}
        openPrLink={props.openPrLink}
        pr={props.prByThreadId.get(threadId) ?? null}
      />
    );
  };

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isDraggable ? props.dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className="cursor-pointer gap-2 px-2 py-1.5 text-left text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-pill-foreground group-hover/project-header:bg-foreground/[0.06] group-hover/project-header:text-pill-foreground"
          {...(isDraggable && props.dragHandleProps ? props.dragHandleProps.attributes : {})}
          {...(isDraggable && props.dragHandleProps ? props.dragHandleProps.listeners : {})}
          onPointerDownCapture={props.handleProjectTitlePointerDownCapture}
          onClick={(event) => props.handleProjectTitleClick(event, project.id)}
          onKeyDown={(event) => props.handleProjectTitleKeyDown(event, project.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            props.markProjectContextMenuPending();
            void props.handleProjectContextMenu(project.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          {!projectExpanded && renderState.projectStatus ? (
            <span
              aria-hidden="true"
              title={renderState.projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${renderState.projectStatus.colorClass}`}
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                <span
                  className={`size-[9px] rounded-full ${renderState.projectStatus.dotClass} ${
                    renderState.projectStatus.pulse ? "animate-pulse" : ""
                  }`}
                />
              </span>
              <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
            </span>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                projectExpanded ? "rotate-90" : ""
              }`}
            />
          )}
          <ProjectAvatar project={project} />
          <span className="flex-1 truncate text-xs font-medium">{project.name}</span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`${props.isPinned ? "Unpin" : "Pin"} project ${project.name}`}
                  />
                }
                showOnHover
                className={cn(
                  "group/project-pin top-1 right-7 size-5 rounded-md bg-transparent p-0 hover:bg-transparent hover:text-foreground",
                  props.isPinned ? "text-foreground" : "text-muted-foreground/70",
                )}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onTogglePinnedProject(project.id);
                }}
              >
                {props.isPinned ? (
                  <span className="relative inline-flex size-4 items-center justify-center">
                    <IconPinFilled className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/project-pin:opacity-0 group-focus-visible/project-pin:opacity-0" />
                    <IconPinnedOff className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover/project-pin:opacity-100 group-focus-visible/project-pin:opacity-100" />
                  </span>
                ) : (
                  <IconPin className="size-4" />
                )}
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">{props.isPinned ? "Unpin project" : "Pin project"}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.name}`}
                    data-testid="new-thread-button"
                  />
                }
                showOnHover
                className="top-1 right-1.5 size-5 rounded-md bg-transparent p-0 text-muted-foreground/70 hover:bg-transparent hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.handleStartNewThreadForProject(project.id);
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">
            {props.newThreadShortcutLabel
              ? `New thread (${props.newThreadShortcutLabel})`
              : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      {shouldRenderThreadPanel ? (
        <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0">
          {renderState.showEmptyThreadState ? (
            <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
              <div
                data-thread-selection-safe
                className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
              >
                <span>No threads yet</span>
              </div>
            </SidebarMenuSubItem>
          ) : null}
          {renderState.renderedThreadIds.map((threadId) => renderThreadRow(threadId))}
          {projectExpanded && renderState.hasHiddenThreads ? (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start bg-transparent px-2 text-left text-[10px] font-medium text-muted-foreground/60 transition-[filter,opacity,color] duration-150 hover:bg-transparent hover:text-foreground/90 hover:opacity-100 hover:brightness-90 dark:hover:text-foreground dark:hover:brightness-125"
                onClick={() => {
                  props.onExpandThreadList(project.id);
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span>Show {Math.min(5, renderState.hiddenThreadCount)} more</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
          {projectExpanded && renderState.canCollapseThreadList ? (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start bg-transparent px-2 text-left text-[10px] font-medium text-muted-foreground/60 transition-[filter,opacity,color] duration-150 hover:bg-transparent hover:text-foreground/90 hover:opacity-100 hover:brightness-90 dark:hover:text-foreground dark:hover:brightness-125"
                onClick={() => {
                  props.onCollapseThreadList(project.id);
                }}
              >
                <span>Show less</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      ) : null}
    </>
  );
});
