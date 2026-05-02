import { ThreadId } from "@ace/contracts";
import { IconArrowsSort, IconFilter2, IconSearch } from "@tabler/icons-react";
import { memo } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type SplitPickerSortOrder = "recent" | "project" | "title";

export const SPLIT_PICKER_SORT_LABELS: Record<SplitPickerSortOrder, string> = {
  recent: "Recent activity",
  project: "Project",
  title: "Thread title",
};

interface SplitPickerThreadOption {
  readonly activityAt: string;
  readonly id: ThreadId;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
}

export const SidebarSplitPickerDialog = memo(function SidebarSplitPickerDialog(props: {
  readonly open: boolean;
  readonly availableThreadCount: number;
  readonly query: string;
  readonly projectFilter: string;
  readonly projectFilterOptions: ReadonlyArray<{ projectId: string; projectName: string }>;
  readonly sortOrder: SplitPickerSortOrder;
  readonly visibleThreads: ReadonlyArray<SplitPickerThreadOption>;
  readonly selectedThreadIds: ReadonlySet<ThreadId>;
  readonly selectedThreadCount: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onQueryChange: (value: string) => void;
  readonly onProjectFilterChange: (value: string) => void;
  readonly onSortOrderChange: (value: SplitPickerSortOrder) => void;
  readonly onToggleThread: (threadId: ThreadId) => void;
  readonly onCancel: () => void;
  readonly onCreate: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New split</DialogTitle>
          <DialogDescription>
            Pick the threads that belong together. They&apos;ll open as one reusable split.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.availableThreadCount < 2 ? (
            <p className="rounded-md border border-border/50 px-3 py-4 text-center text-sm text-muted-foreground">
              Add at least two active threads before creating a split.
            </p>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <IconSearch className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground/60" />
                  <Input
                    value={props.query}
                    onChange={(event) => props.onQueryChange(event.target.value)}
                    placeholder="Search threads or projects"
                    className="h-9 bg-background/60 pl-8 text-sm"
                    autoFocus
                  />
                </div>
                <Menu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <MenuTrigger className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground" />
                      }
                    >
                      <IconFilter2 className="size-4" />
                    </TooltipTrigger>
                    <TooltipPopup>Filter threads</TooltipPopup>
                  </Tooltip>
                  <MenuPopup align="end" side="bottom" className="min-w-44">
                    <MenuGroup>
                      <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">
                        Filter by project
                      </div>
                      <MenuRadioGroup
                        value={props.projectFilter}
                        onValueChange={props.onProjectFilterChange}
                      >
                        <MenuRadioItem value="all" className="min-h-7 py-1 sm:text-xs">
                          All projects
                        </MenuRadioItem>
                        {props.projectFilterOptions.map((project) => (
                          <MenuRadioItem
                            key={project.projectId}
                            value={project.projectId}
                            className="min-h-7 py-1 sm:text-xs"
                          >
                            {project.projectName}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuPopup>
                </Menu>
                <Menu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <MenuTrigger className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground" />
                      }
                    >
                      <IconArrowsSort className="size-4" />
                    </TooltipTrigger>
                    <TooltipPopup>Sort threads</TooltipPopup>
                  </Tooltip>
                  <MenuPopup align="end" side="bottom" className="min-w-40">
                    <MenuGroup>
                      <div className="px-2 py-1 font-medium text-muted-foreground sm:text-xs">
                        Sort by
                      </div>
                      <MenuRadioGroup
                        value={props.sortOrder}
                        onValueChange={(value) =>
                          props.onSortOrderChange(value as SplitPickerSortOrder)
                        }
                      >
                        {(
                          Object.entries(SPLIT_PICKER_SORT_LABELS) as Array<
                            [SplitPickerSortOrder, string]
                          >
                        ).map(([value, label]) => (
                          <MenuRadioItem
                            key={value}
                            value={value}
                            className="min-h-7 py-1 sm:text-xs"
                          >
                            {label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuPopup>
                </Menu>
              </div>
              <div className="flex items-center justify-between px-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/65">
                <span>
                  {props.selectedThreadCount > 0
                    ? `${props.selectedThreadCount} selected`
                    : "Choose at least 2"}
                </span>
                <span>{props.visibleThreads.length} shown</span>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {props.visibleThreads.length > 0 ? (
                  props.visibleThreads.map((thread) => {
                    const selected = props.selectedThreadIds.has(thread.id);
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:bg-foreground/[0.06] focus-visible:text-foreground",
                          selected
                            ? "bg-foreground/[0.06] text-foreground"
                            : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                        )}
                        onClick={() => props.onToggleThread(thread.id)}
                      >
                        <Checkbox
                          checked={selected}
                          tabIndex={-1}
                          className="pointer-events-none"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground/92">{thread.title}</div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/68">
                            <span className="truncate">{thread.projectName}</span>
                            <span className="shrink-0">•</span>
                            <span className="shrink-0">
                              Active {formatRelativeTimeLabel(thread.activityAt)}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <p className="rounded-md px-3 py-6 text-center text-sm text-muted-foreground/60">
                    No matching threads
                  </p>
                )}
              </div>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={props.selectedThreadCount < 2} onClick={props.onCreate}>
            {props.selectedThreadCount >= 2
              ? `Create split (${props.selectedThreadCount})`
              : "Create split"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
