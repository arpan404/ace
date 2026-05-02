import { IconFilter2 } from "@tabler/icons-react";
import { type DragEvent } from "react";
import { ChevronRightIcon, Columns2Icon, PlusIcon } from "lucide-react";

import type { ChatThreadBoardSplitState } from "../../chatThreadBoardStore";
import type { SidebarBoardListItem } from "../../lib/threadBoardList";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export type SidebarSplitSortOrder = "updated_at" | "created_at" | "name" | "pane_count";

const SIDEBAR_SPLIT_SORT_LABELS: Record<SidebarSplitSortOrder, string> = {
  updated_at: "Recent activity",
  created_at: "Recently created",
  name: "Title",
  pane_count: "Split size",
};

export function SidebarBoardsSection(props: {
  activeSplitId: string | null;
  boardItems: ReadonlyArray<SidebarBoardListItem>;
  boardsSectionExpanded: boolean;
  canCollapseSplitList: boolean;
  canCreateBoard: boolean;
  hiddenSavedSplitCount: number;
  renamingSplitId: string | null;
  renamingSplitTitle: string;
  showMoreCount: number;
  splitSortOrder: SidebarSplitSortOrder;
  threadDragActive: boolean;
  dragOverBoardId: string | null;
  visibleBoardItems: ReadonlyArray<SidebarBoardListItem>;
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
  onBoardDragLeave: (splitId: string, event: DragEvent<HTMLLIElement>) => void;
  onBoardDragOver: (split: ChatThreadBoardSplitState, event: DragEvent<HTMLLIElement>) => void;
  onBoardDrop: (split: ChatThreadBoardSplitState, event: DragEvent<HTMLLIElement>) => void;
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
            Splits
          </span>
          <ChevronRightIcon
            className={`size-4 text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 group-hover/section-header:text-foreground group-hover/section-header:opacity-100 ${
              props.boardsSectionExpanded ? "rotate-90" : ""
            }`}
          />
        </button>
        <div className="flex items-center gap-1">
          {props.boardItems.length > 0 ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
                  }
                >
                  <IconFilter2 className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="right">Sort splits</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end" side="bottom" className="min-w-40">
                <MenuGroup>
                  <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">
                    Sort splits
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
                  aria-label="New split"
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={!props.canCreateBoard}
                  onClick={props.onOpenSplitPicker}
                />
              }
            >
              <PlusIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">New split</TooltipPopup>
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
          {props.threadDragActive ? (
            <div className="mb-1 rounded-md border border-dashed border-primary/35 bg-primary/[0.06] px-2 py-1.5 text-[10px] font-medium text-primary/80">
              Drop on a thread to start a split, or drop on a saved split to add it there.
            </div>
          ) : null}
          <SidebarMenu>
            {props.visibleBoardItems.map((item) => {
              const { split } = item;
              const isActiveSplit = props.activeSplitId === split.id;
              return (
                <SidebarMenuItem
                  key={split.id}
                  className={cn(
                    "rounded-md transition-colors",
                    props.dragOverBoardId === split.id
                      ? "bg-primary/[0.08] ring-1 ring-primary/35"
                      : "",
                  )}
                  onDragLeave={(event) => {
                    props.onBoardDragLeave(split.id, event);
                  }}
                  onDragOver={(event) => {
                    props.onBoardDragOver(split, event);
                  }}
                  onDrop={(event) => {
                    props.onBoardDrop(split, event);
                  }}
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
                        "h-auto w-full cursor-pointer gap-2 px-2 py-1.5 text-left text-xs transition-colors duration-150 focus-visible:!ring-1 focus-visible:!ring-ring/35 focus-visible:ring-inset",
                        isActiveSplit
                          ? "!bg-foreground/[0.06] !text-pill-foreground"
                          : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-pill-foreground",
                      )}
                      title={split.title}
                      onClick={() => {
                        props.onRestoreSavedSplit(split);
                      }}
                    >
                      <Columns2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/72" />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/92">
                        {split.title}
                      </span>
                      <span className="shrink-0 rounded-full border border-border/45 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/68">
                        {split.panes.length}
                      </span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              );
            })}
            {props.boardItems.length === 0 ? (
              <SidebarMenuItem>
                <div className="h-7 px-2 text-xs text-muted-foreground/60">No splits yet</div>
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
