import { type ProjectId } from "@ace/contracts";
import { IconSearch } from "@tabler/icons-react";
import { ChevronLeftIcon, FolderIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { memo, type KeyboardEvent, type RefObject } from "react";

import type { Project } from "../../types";
import { ProjectAvatar } from "../ProjectAvatar";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import type { SearchPaletteItem, SearchPaletteMode } from "./sidebarTypes";

const SearchPaletteFooterHints = memo(function SearchPaletteFooterHints() {
  return (
    <div className="flex items-center justify-between border-t border-border/40 bg-muted/30 px-4 py-2.5 text-muted-foreground text-xs gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex gap-0.5">
            <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
              ↑
            </span>
            <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
              ↓
            </span>
          </span>
          <span className="font-medium">Navigate</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded border border-border/50 bg-background/50 px-2 py-0.5 text-[10px] font-medium text-foreground/70">
            Enter
          </span>
          <span className="font-medium">Select</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
            Esc
          </span>
          <span className="font-medium">Close</span>
        </span>
      </div>
    </div>
  );
});

function renderActionIcon(item: SearchPaletteItem) {
  if (item.type === "action.new-thread") {
    return <SquarePenIcon className="size-4 shrink-0" strokeWidth={2} />;
  }
  if (item.type === "action.new-project") {
    return <FolderIcon className="size-4 shrink-0" strokeWidth={2} />;
  }
  return <SettingsIcon className="size-4 shrink-0" strokeWidth={2} />;
}

export const SidebarSearchPaletteDialog = memo(function SidebarSearchPaletteDialog(props: {
  readonly open: boolean;
  readonly mode: SearchPaletteMode;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly items: ReadonlyArray<SearchPaletteItem>;
  readonly actionItems: ReadonlyArray<SearchPaletteItem>;
  readonly projectItems: ReadonlyArray<SearchPaletteItem>;
  readonly threadItems: ReadonlyArray<SearchPaletteItem>;
  readonly indexById: ReadonlyMap<string, number>;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack: () => void;
  readonly onQueryChange: (value: string) => void;
  readonly onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onHoverItem: (itemId: string) => void;
  readonly onSelectItem: (item: SearchPaletteItem) => void;
}) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="flex max-h-[min(31.5rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border/50 bg-popover/98 p-0 shadow-lg">
        <div className="flex items-center gap-3 border-b border-border/40 bg-gradient-to-b from-popover/50 to-popover/20 px-4 py-3">
          {props.mode === "new-thread-project" ? (
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-accent/80 hover:text-foreground active:scale-95"
              onClick={props.onBack}
              aria-label="Back to search"
            >
              <ChevronLeftIcon className="size-5" strokeWidth={2.5} />
            </button>
          ) : (
            <IconSearch className="size-5 shrink-0 text-muted-foreground/60" strokeWidth={2} />
          )}
          <input
            ref={props.inputRef}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border/50 bg-background/60 px-3 text-sm font-medium text-foreground placeholder:text-muted-foreground/50 transition-all focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
            placeholder={
              props.mode === "new-thread-project"
                ? "Select project for a new thread..."
                : "Search commands, projects, and threads..."
            }
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={props.onInputKeyDown}
            autoFocus
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={props.listRef}>
          {props.items.length === 0 ? (
            <p className="px-0 py-6 text-center text-sm text-muted-foreground/60">
              No matching results
            </p>
          ) : (
            <div className="py-1">
              {props.mode === "root" &&
              props.normalizedQuery.length === 0 &&
              props.actionItems.length > 0 ? (
                <p className="px-0 pt-0 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                  Actions
                </p>
              ) : null}
              {props.actionItems.map((item) => {
                const itemIndex = props.indexById.get(item.id) ?? -1;
                const isActive = itemIndex === props.activeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-search-palette-index={itemIndex}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-all duration-150 ${
                      isActive
                        ? "bg-primary/15 text-foreground"
                        : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                    }`}
                    onMouseMove={() => props.onHoverItem(item.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => props.onSelectItem(item)}
                  >
                    <span className={`text-muted-foreground ${isActive ? "text-primary/70" : ""}`}>
                      {renderActionIcon(item)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                );
              })}

              {props.projectItems.length > 0 ? (
                <>
                  <p className="px-0 pt-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {props.mode === "new-thread-project"
                      ? "Projects"
                      : props.normalizedQuery.length === 0
                        ? "Recent Projects"
                        : "Projects"}
                  </p>
                  {props.projectItems.map((item) => {
                    if (item.type !== "project") {
                      return null;
                    }
                    const itemIndex = props.indexById.get(item.id) ?? -1;
                    const isActive = itemIndex === props.activeIndex;
                    const project =
                      item.connectionUrl === undefined
                        ? props.projectById.get(item.projectId)
                        : undefined;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-search-palette-index={itemIndex}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-all duration-150 ${
                          isActive
                            ? "bg-primary/15 text-foreground"
                            : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                        }`}
                        onMouseMove={() => props.onHoverItem(item.id)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => props.onSelectItem(item)}
                      >
                        {project ? (
                          <ProjectAvatar project={project} className="size-5" />
                        ) : (
                          <FolderIcon
                            className="size-4 shrink-0 text-muted-foreground/60"
                            strokeWidth={2}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.label}</span>
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {item.description}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </>
              ) : null}

              {props.mode === "root" && props.threadItems.length > 0 ? (
                <>
                  <p className="px-0 pt-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                    {props.normalizedQuery.length === 0 ? "Recent Threads" : "Threads"}
                  </p>
                  {props.threadItems.map((item) => {
                    const itemIndex = props.indexById.get(item.id) ?? -1;
                    const isActive = itemIndex === props.activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-search-palette-index={itemIndex}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-all duration-150 ${
                          isActive
                            ? "bg-primary/15 text-foreground"
                            : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                        }`}
                        onMouseMove={() => props.onHoverItem(item.id)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => props.onSelectItem(item)}
                      >
                        <SquarePenIcon
                          className="size-4 shrink-0 text-muted-foreground/60"
                          strokeWidth={2}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.label}</span>
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {item.description}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </>
              ) : null}
            </div>
          )}
        </div>

        <SearchPaletteFooterHints />
      </CommandDialogPopup>
    </CommandDialog>
  );
});
