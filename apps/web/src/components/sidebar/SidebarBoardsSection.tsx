import { IconFilter2 } from "@tabler/icons-react";
import { ChevronRightIcon, Columns2Icon, PlusIcon } from "lucide-react";

import type { ChatThreadBoardSplitState } from "../../chatThreadBoardStore";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export type SidebarSplitSortOrder = "updated_at" | "created_at" | "name" | "pane_count";

const SIDEBAR_SPLIT_SORT_LABELS: Record<SidebarSplitSortOrder, string> = {
  updated_at: "Recent activity",
  created_at: "Created at",
  name: "Name",
  pane_count: "Thread count",
};

export function SidebarBoardsSection(props: {
  activeRouteSplitId: string | null;
  boardsSectionExpanded: boolean;
  canCollapseSplitList: boolean;
  canCreateBoard: boolean;
  hiddenSavedSplitCount: number;
  renamingSplitId: string | null;
  renamingSplitTitle: string;
  savedBoards: ReadonlyArray<ChatThreadBoardSplitState>;
  showMoreCount: number;
  splitSortOrder: SidebarSplitSortOrder;
  visibleSavedBoards: ReadonlyArray<ChatThreadBoardSplitState>;
  onBoardsSectionToggle: () => void;
  onCancelSplitRename: () => void;
  onCommitSplitRename: (split: ChatThreadBoardSplitState) => void;
  onOpenSplitContextMenu: (
    split: ChatThreadBoardSplitState,
    position: { x: number; y: number },
  ) => void;
  onOpenSplitPicker: () => void;
  onRestoreSavedSplit: (split: ChatThreadBoardSplitState) => void;
  onShowLess: () => void;
  onShowMore: () => void;
  onSplitRenameChange: (title: string) => void;
  onSplitSortOrderChange: (sortOrder: SidebarSplitSortOrder) => void;
}) {
  return (
    <SidebarGroup className="order-last px-2.5 pt-1 pb-2">
      <div className="mb-1.5 flex items-center justify-between pl-2 pr-1.5">
        <button
          type="button"
          className="group/section-header flex h-5 min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left"
          aria-expanded={props.boardsSectionExpanded}
          onClick={props.onBoardsSectionToggle}
        >
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors group-hover/section-header:text-foreground">
            Boards
          </span>
          <ChevronRightIcon
            className={`size-4 text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 group-hover/section-header:text-foreground group-hover/section-header:opacity-100 ${
              props.boardsSectionExpanded ? "rotate-90" : ""
            }`}
          />
        </button>
        <div className="flex items-center gap-1">
          {props.savedBoards.length > 0 ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
                  }
                >
                  <IconFilter2 className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="right">Sort boards</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" side="bottom" className="min-w-40">
                <MenuGroup>
                  <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">
                    Sort boards
                  </div>
                  <MenuRadioGroup
                    value={props.splitSortOrder}
                    onValueChange={(value) =>
                      props.onSplitSortOrderChange(value as SidebarSplitSortOrder)
                    }
                  >
                    {(
                      Object.entries(SIDEBAR_SPLIT_SORT_LABELS) as Array<
                        [SidebarSplitSortOrder, string]
                      >
                    ).map(([value, label]) => (
                      <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                        {label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New board"
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={!props.canCreateBoard}
                  onClick={props.onOpenSplitPicker}
                />
              }
            >
              <PlusIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">New board</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div
        aria-hidden={!props.boardsSectionExpanded}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          props.boardsSectionExpanded
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <SidebarMenu>
            {props.visibleSavedBoards.map((split) => {
              const paneCount = split.panes.length;
              const isActiveSplit = props.activeRouteSplitId === split.id;
              return (
                <SidebarMenuItem
                  key={split.id}
                  className="rounded-md"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    props.onOpenSplitContextMenu(split, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  {props.renamingSplitId === split.id ? (
                    <form
                      className="flex h-7 min-w-0 items-center px-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        props.onCommitSplitRename(split);
                      }}
                    >
                      <Input
                        value={props.renamingSplitTitle}
                        onChange={(event) => {
                          props.onSplitRenameChange(event.target.value);
                        }}
                        onBlur={() => {
                          props.onCommitSplitRename(split);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            props.onCancelSplitRename();
                          }
                        }}
                        className="h-6 bg-transparent px-1.5 text-xs"
                        autoFocus
                      />
                    </form>
                  ) : (
                    <SidebarMenuButton
                      render={<button type="button" />}
                      size="sm"
                      className={cn(
                        "h-7 w-full cursor-pointer gap-2 px-2 text-left text-xs transition-colors duration-150 focus-visible:!ring-1 focus-visible:!ring-ring/35 focus-visible:ring-inset",
                        isActiveSplit
                          ? "!bg-foreground/[0.06] !text-pill-foreground"
                          : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-pill-foreground",
                      )}
                      title={split.title}
                      onClick={() => {
                        props.onRestoreSavedSplit(split);
                      }}
                    >
                      <Columns2Icon className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{split.title}</span>
                      <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/60">
                        {paneCount}
                      </span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              );
            })}
            {props.savedBoards.length === 0 ? (
              <SidebarMenuItem>
                <div className="h-7 px-2 text-xs text-muted-foreground/60">No boards yet</div>
              </SidebarMenuItem>
            ) : null}
            {props.hiddenSavedSplitCount > 0 ? (
              <SidebarMenuItem className="rounded-md">
                <button
                  type="button"
                  className="flex h-6 w-full cursor-pointer items-center justify-start bg-transparent px-2 text-left text-[10px] font-medium text-muted-foreground/60 outline-none transition-[filter,opacity,color] duration-150 hover:bg-transparent hover:text-foreground/90 hover:opacity-100 hover:brightness-90 focus-visible:text-foreground/90 dark:hover:text-foreground dark:hover:brightness-125"
                  onClick={props.onShowMore}
                >
                  <span>Show {props.showMoreCount} more</span>
                </button>
              </SidebarMenuItem>
            ) : null}
            {props.canCollapseSplitList ? (
              <SidebarMenuItem className="rounded-md">
                <button
                  type="button"
                  className="flex h-6 w-full cursor-pointer items-center justify-start bg-transparent px-2 text-left text-[10px] font-medium text-muted-foreground/60 outline-none transition-[filter,opacity,color] duration-150 hover:bg-transparent hover:text-foreground/90 hover:opacity-100 hover:brightness-90 focus-visible:text-foreground/90 dark:hover:text-foreground dark:hover:brightness-125"
                  onClick={props.onShowLess}
                >
                  <span>Show less</span>
                </button>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </div>
      </div>
    </SidebarGroup>
  );
}
